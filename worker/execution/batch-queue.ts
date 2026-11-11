import type { Env } from "../types";
import { check, HttpError } from "../http";
import type { ExecutionSnapshot, RunnerEvent } from "../../shared/agent/contracts";
import type { ExecutionRunView } from "../../shared/agent/execution";
import type { BatchGateRequest, BatchGateResponse, QueueControl, QueuePhase, QueueView } from "../../shared/agent/queue";
import type { ExecutionPrincipal } from "./execution-auth";
import { canonical, hash } from "./outbox";
import { callAgentChecklist } from "../checklist-client";
import { ChecklistWritebacks, scheduleExecutionAlarm } from "./checklist-writeback";

export interface QueueState {
  revision: number; index: number; phase: QueuePhase; pauseRequested: boolean;
  reason?: string; repairs: Record<string, number>; human: Record<string, true>;
  accepted: Record<string, string>; permits: Record<string, BatchGateResponse>;
  verificationTurn?: string;
  recovery?: { recoveryId: string; revision: number; commandId: string; threadId: string; completedTurnId: string; index: number };
}
export const initialQueue = (): QueueState => ({revision:1,index:0,phase:"running",pauseRequested:false,repairs:{},human:{},accepted:{},permits:{}});
export type QueueRun = {principal:ExecutionPrincipal;snapshot:ExecutionSnapshot;view:ExecutionRunView;queueState?:QueueState};
export const isManaged = (r: QueueRun) => r.snapshot.kind === "task" && r.snapshot.batch?.managed === true;
const terminal = (p: QueuePhase) => p === "completed" || p === "cancelled";

// RunnerHub serializes this controller with commands, events and lease changes.
// Native reports describe execution; this journal alone grants the next turn.
export class BatchQueue {
  constructor(private storage:DurableObjectStorage,private env:Env) {}
  private state(r:QueueRun) {
    check(isManaged(r),"此批次不使用持久队列。",409);
    const q=r.queueState ??= initialQueue();
    // Older local records duplicated the entire proof in both queue state and
    // its view. Proof events already own durable storage; retain only identity.
    if (Object.hasOwn(q,"verification")) {
      q.verificationTurn ??= r.view.turnId ?? undefined;
      delete (q as QueueState & {verification?:unknown}).verification;
    }
    return q;
  }
  private view(r:QueueRun):QueueView {
    const q=this.state(r);
    const admitted=Object.entries(q.permits).find(([key,p])=>key===`${r.view.commandId}:${q.index}:${r.view.turnId}`&&p.decision==="advance")?.[1];
    const index=admitted?.nextIndex??q.index;
    return {managed:true,revision:q.revision,phase:q.phase,currentIndex:index,turnId:index!==q.index?null:r.view.turnId,pauseRequested:q.pauseRequested,canResume:q.phase==="paused"&&r.view.status!=="reconciliation_required",repairCount:q.repairs[String(index)]??0,...(q.reason?{reason:q.reason}:{})};
  }
  async decorate(r:QueueRun,view:ExecutionRunView=r.view):Promise<ExecutionRunView> {
    if(!isManaged(r)||!view.queue)return view;
    const turn=r.queueState?.verificationTurn;
    if(!turn)return view;
    const proof=await this.storage.get<RunnerEvent>(`exec:queue-proof:${r.view.runId}:${turn}:verification.completed`);
    if(proof?.type!=="verification.completed")return view;
    return {...view,queue:{...view.queue,verification:{results:proof.payload.results}}};
  }
  private async save(r:QueueRun) {
    const previous=r.view.queue, next=this.view(r);
    if(previous && canonical({...previous,revision:0})!==canonical({...next,revision:0})) {r.queueState!.revision++;next.revision=r.queueState!.revision;}
    r.view.queue=next;r.view.updatedAt=new Date().toISOString();
    await this.storage.put("exec:run:"+r.view.runId,r);
  }
  async initialize(r:QueueRun) { if(isManaged(r)){this.state(r);await this.save(r);} }
  async cancel(r:QueueRun) {
    if(!isManaged(r))return;const q=this.state(r);
    q.phase=r.view.terminal&&r.view.stopConfirmed?"cancelled":"cancel_requested";q.pauseRequested=true;q.reason="已请求停止剩余待办。";await this.save(r);
  }
  async reply(r:QueueRun) {
    if(!isManaged(r))return;const q=this.state(r);
    check(!terminal(q.phase)&&q.phase!=="cancel_requested", "批次已停止或完成。",409);
    check(!q.accepted[String(q.index)],"已验收的待办不能重复执行。",409);
    q.phase=q.pauseRequested?"pause_requested":"running";delete q.verificationTurn;delete q.reason;await this.save(r);
  }
  async observe(r:QueueRun) {
    if(!isManaged(r))return;
    const q=this.state(r), b=r.view.batch;
    if(r.view.status==="cancelled"||r.view.status==="cancel_requested")return this.cancel(r);
    if(!b)return;
    const index=b.currentIndex;
    if(index!==q.index) {
      check(index===q.index+1&&Object.values(q.permits).some(p=>p.decision==="advance"&&p.nextIndex===index),"下一项尚未通过队列授权。",409);
      q.index=index;q.phase=q.pauseRequested?"pause_requested":"running";delete q.verificationTurn;delete q.reason;
    }
    const item=b.items[index];
    if(item.status==="done") {
      if(r.view.terminal&&r.view.stopConfirmed) {
        check(index===b.items.length-1&&Object.values(q.permits).some(p=>p.decision==="finish"),"最终清单尚未验收回写。",409);
        q.phase="completed";delete q.reason;
      } else if(!["paused","waiting_human","finalizing","blocked"].includes(q.phase))q.phase="verifying";
    } else if(["blocked","needs_input","failed"].includes(item.status)||r.view.status==="reconciliation_required") {
      q.phase="blocked";q.reason=item.summary||r.view.error||"本项需要补充信息或重新核对执行状态。";
    } else if(!terminal(q.phase)&&q.phase!=="cancel_requested")q.phase=q.pauseRequested?"pause_requested":"running";
    await this.save(r);
  }
  async control(r:QueueRun,input:QueueControl) {
    const q=this.state(r),key=`exec:queue-control:${r.principal.ownerId}:${input.requestId}`,digest=await hash({principal:r.principal,input});
    check(input.bindingId===r.principal.bindingId&&input.bindingRevision===r.principal.bindingRevision,"绑定已更改。",409);
    const old=await this.storage.get<{hash:string;queue:QueueView}>(key);
    if(old){check(old.hash===digest,"请求编号已用于不同队列操作。",409);return {queue:old.queue};}
    check(input.expectedRevision===q.revision,"批次状态已更改，请刷新后操作。",409);
    check(!terminal(q.phase)&&q.phase!=="cancel_requested","此批次已结束。",409);
    if(input.action==="pause") {q.pauseRequested=true;if(q.phase==="running")q.phase="pause_requested";}
    if(input.action==="resume") {check(q.phase==="paused"&&r.view.status!=="reconciliation_required","只有已核对连接的暂停批次可以继续。",409);q.pauseRequested=false;q.phase="verifying";delete q.reason;delete q.recovery;}
    if(input.action==="confirm") {check(q.phase==="waiting_human"&&input.expectedTurnId===r.view.turnId&&!!input.expectedTurnId,"待确认的验收轮次已更改。",409);q.human[input.expectedTurnId]=true;q.phase="verifying";delete q.reason;}
    if(input.action==="recover") {
      check(q.phase==="blocked"||q.phase==="finalizing"||q.phase==="paused","此批次不需要重新核对。",409);
      if(q.phase==="paused") {
        await this.assertRecoveryCheckpoint(r);
        q.revision++;
        q.recovery={recoveryId:crypto.randomUUID(),revision:q.revision,commandId:r.view.commandId!,threadId:r.view.threadId!,completedTurnId:r.view.turnId!,index:q.index};
      } else delete q.reason;
    }
    await this.save(r);
    // A UI operation may reconcile existing evidence/writeback, but never grants
    // a native permit or repeats execution. Only native batch-gate does that.
    if(input.action==="recover"&&q.phase!=="paused")await this.reconcile(r);
    const result={queue:(await this.decorate(r)).queue!};await this.storage.put(key,{hash:digest,...result});return result;
  }
  private async assertRecoveryCheckpoint(r:QueueRun) {
    const q=this.state(r), item=r.view.batch?.items[q.index];
    check(q.phase==="paused"&&q.pauseRequested&&!r.view.terminal&&!r.view.stopConfirmed&&!["cancel_requested","cancelled"].includes(r.view.status),"只能恢复尚未停止的安全暂停点。",409);
    check(r.view.threadId&&r.view.turnId&&item?.status==="done"&&item.completedTurnId===r.view.turnId&&q.accepted[String(q.index)]===r.view.turnId,"暂停点没有已验收的原轮次。",409);
    check(!q.permits[`${r.view.commandId}:${q.index}:${r.view.turnId}`],"下一轮已取得执行许可，不能恢复旧暂停点。",409);
    const batch=r.snapshot.kind==="task"?r.snapshot.batch:undefined;
    const writebacks=await this.storage.get<{entries:{taskId:string;completedTurnId:string;status:string}[]}>(`exec:writebacks:${r.view.runId}`);
    const writeback=writebacks?.entries.find(entry=>entry.taskId===item!.taskId);
    check(!batch?.autoComplete||!batch.items[q.index].source||(writeback?.status==="applied"&&writeback.completedTurnId===r.view.turnId),"清单回写尚未确认。",409);
    await this.validate(r,q.index+1);
    return q;
  }
  async recovery(r:QueueRun,input:{commandId:string;threadId:string;completedTurnId:string}) {
    const ticket=this.state(r).recovery;
    if(!ticket)return undefined;
    const q=await this.assertRecoveryCheckpoint(r);
    check(ticket.revision===q.revision&&ticket.commandId===r.view.commandId&&ticket.commandId===input.commandId&&ticket.threadId===r.view.threadId&&ticket.threadId===input.threadId&&ticket.completedTurnId===r.view.turnId&&ticket.completedTurnId===input.completedTurnId&&ticket.index===q.index,"恢复请求的暂停点已改变。",409);
    return ticket;
  }
  private async validate(r:QueueRun,start:number) {
    if(r.snapshot.kind!=="task"||!r.snapshot.batch)return;
    const items=r.snapshot.batch.items.slice(start).filter(i=>i.source);
    if(!items.length)return;
    const value=await callAgentChecklist(this.env,r.principal,{action:"validate",tasks:items.map(i=>({noteId:i.source!.taskRef.noteId,taskId:i.source!.taskRef.taskId,generation:i.source!.generation,specRevision:i.source!.specRevision}))});
    check(canonical(value.items)===canonical(items),"待办规格或排序已改变，请停止后重新提交未完成项。",409);
  }
  async validateDispatch(r:QueueRun) {
    if(!isManaged(r))return;
    const q=this.state(r);
    if(terminal(q.phase)||q.phase==="cancel_requested")return;
    try {await this.validate(r,q.accepted[String(q.index)]?q.index+1:q.index);}
    catch(error) {q.phase="blocked";q.reason="待办规格或排序已改变，执行已阻止，请停止后重新提交未完成项。";await this.save(r);throw error;}
  }
  private async reconcile(r:QueueRun):Promise<"wait"|"ready"|"repair"|"blocked"> {
    const q=this.state(r),b=r.view.batch!, item=b.items[q.index];
    if(terminal(q.phase)||q.phase==="cancel_requested")return "blocked";
    if(item.status!=="done"||!item.completedTurnId||item.completedTurnId!==r.view.turnId) {
      await this.observe(r);return q.phase==="blocked"?"blocked":"wait";
    }
    const turn=item.completedTurnId, accepted=q.accepted[String(q.index)]===turn;
    // A persisted pause is stable until an explicit control operation. Rewriting
    // finalizing -> paused on every poll would invalidate the UI's CAS revision.
    if(q.phase==="paused"&&q.pauseRequested)return "wait";
    if(!accepted) {
      const done=await this.storage.get<RunnerEvent>(`exec:queue-proof:${r.view.runId}:${turn}:turn.completed`);
      const evidence=await this.storage.get<RunnerEvent>(`exec:queue-proof:${r.view.runId}:${turn}:verification.completed`);
      if(!done||!evidence) {q.phase="verifying";q.reason="等待本机执行与验收凭据。";await this.save(r);return "wait";}
      check(done.type==="turn.completed"&&evidence.type==="verification.completed"&&done.threadId===r.view.threadId&&evidence.threadId===r.view.threadId&&done.turnId===turn&&evidence.turnId===turn,"验收凭据所属轮次不一致。",409);
      check(done.payload.status==="completed"&&done.payload.outcome?.outcome==="done"&&done.payload.outcome.runId===r.view.runId&&done.payload.outcome.taskId===item.taskId,"该轮未完成当前待办。",409);
      const snapshot=r.snapshot.kind==="task"?r.snapshot.batch!:null!;
      const criteria=snapshot.items[q.index].acceptance,results=evidence.payload.results;
      q.verificationTurn=turn;
      check(new Set(results.map(v=>v.criterionId)).size===results.length&&results.every(v=>criteria.some(c=>c.id===v.criterionId)),"验收条件与提交快照不一致。",409);
      const machine=criteria.filter(c=>c.required&&c.kind!=="human");
      const failed=machine.filter(c=>{const v=results.find(v=>v.criterionId===c.id);return !v||v.status!=="passed"||!v.evidenceRefs.length||(c.kind==="command"?v.exitCode!==0:!v.outputHash?.match(/^[a-f0-9]{64}$/));});
      if(failed.length) {
        const repairable=failed.every(c=>{const v=results.find(v=>v.criterionId===c.id);return v?.status==="failed"&&["predicate","command_exit"].includes(v.failureKind??"");});
        q.reason="验收未通过："+failed.map(c=>c.description).join("；").slice(0,1500);
        q.phase="blocked";await this.save(r);
        return repairable&&(q.repairs[String(q.index)]??0)<1&&!q.pauseRequested?"repair":"blocked";
      }
      if(criteria.some(c=>c.required&&c.kind==="human")&&!q.human[turn]) {q.phase="waiting_human";q.reason="请确认当前待办的人工验收条件。";await this.save(r);return "wait";}
    }
    const writes=new ChecklistWritebacks(this.storage,this.env);
    const decorated=await writes.decorate(r), writeback=decorated.batch?.items[q.index].writeback;
    try {await this.validate(r,writeback?.status==="applied"?q.index+1:q.index);}
    catch(error) {q.phase="blocked";q.reason=error instanceof HttpError&&error.status===409?"待办规格或排序已改变，请停止后重新提交未完成项。":"无法核对当前清单，请稍后重新核对。";await this.save(r);return "blocked";}
    q.accepted[String(q.index)]=turn;q.phase="finalizing";q.reason="正在将已验收结果同步到清单。";
    const updates=await writes.stage(r,[item.taskId]);
    r.view.queue=this.view(r);
    await this.storage.put({["exec:run:"+r.view.runId]:r,...updates});
    await scheduleExecutionAlarm(this.storage);await writes.flushRun(r.view.runId);
    const wb=(await writes.decorate(r)).batch?.items[q.index].writeback;
    if(wb&&wb.status!=="applied"&&wb.status!=="disabled") {
      q.phase=wb.status==="pending"?"finalizing":"blocked";q.reason=wb.message||"清单尚未确认完成，后续待办等待。";await this.save(r);return q.phase==="blocked"?"blocked":"wait";
    }
    // Completion may have raced with a user edit of a later task.
    try {await this.validate(r,q.index+1);}catch {q.phase="blocked";q.reason="后续待办已变化，请停止后重新提交未完成项。";await this.save(r);return "blocked";}
    if(q.pauseRequested&&q.index+1<b.items.length) {q.phase="paused";q.reason="当前待办已验收，后续待办已暂停。";await this.save(r);return "wait";}
    delete q.reason;await this.save(r);return "ready";
  }
  async gate(r:QueueRun,input:BatchGateRequest):Promise<BatchGateResponse> {
    const q=this.state(r);
    check(input.commandId===r.view.commandId&&input.fromIndex===r.view.batch?.currentIndex&&input.completedTurnId===r.view.turnId&&input.reportRevision===r.view.reportRevision,"执行轮次或报告已更改。",409);
    if(q.phase==="cancel_requested"||q.phase==="cancelled")return {decision:"blocked",queueRevision:q.revision,reason:"批次已停止。"};
    const key=`${input.commandId}:${input.fromIndex}:${input.completedTurnId}`;
    if(q.permits[key])return q.permits[key];
    const result=await this.reconcile(r);
    if(result==="ready"||result==="repair") {
      if(result==="repair") {
        try {await this.validate(r,q.index);}catch {q.phase="blocked";q.reason="待办规格或排序已改变，不能自动修复旧任务。";await this.save(r);return {decision:"blocked",queueRevision:q.revision,reason:q.reason};}
      }
      const decision=result==="repair"?"repair":q.index+1===r.view.batch!.items.length?"finish":"advance";
      if(decision==="repair") {q.repairs[String(q.index)]=(q.repairs[String(q.index)]??0)+1;q.phase="running";}
      else if(decision==="advance")q.phase="running";
      await this.save(r);
      const response:BatchGateResponse={decision,queueRevision:q.revision,permitId:crypto.randomUUID(),...(decision==="advance"?{nextIndex:q.index+1}:decision==="repair"?{nextIndex:q.index}:{}),...(decision==="repair"&&q.reason?{reason:q.reason}:{})};
      q.permits[key]=response;await this.save(r);response.queueRevision=q.revision;await this.save(r);return response;
    }
    return {decision:result==="blocked"?"blocked":"wait",queueRevision:q.revision,...(q.reason?{reason:q.reason}:{})};
  }
}
