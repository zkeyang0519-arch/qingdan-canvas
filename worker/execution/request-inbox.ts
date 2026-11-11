import type { Env } from "../types";
import { check } from "../http";
import type { RunnerEvent } from "../../shared/agent/contracts";
import type { ExecutionRunView } from "../../shared/agent/execution";
import type { ExecutionRespond, ExecutionResponseReceipt, NativeRequestResponse, NativeResponseAck, PendingExecutionRequest, RequestResponse } from "../../shared/agent/permissions";
import type { QueueRun } from "./batch-queue";
import { canonical, hash } from "./outbox";

interface RequestRecord extends Omit<PendingExecutionRequest,"responseStatus"> {
  state:"pending"|"queued"|"responded"|"expired"|"cancelled";
  responseId?:string; reason?:string;
  seenCurrent?:true;
}
interface ResponseRecord extends Omit<NativeRequestResponse,"response">,ExecutionResponseReceipt {
  response?:RequestResponse;hash:string;requestId:string;reason?:string;
}
const prefix=(runId:string)=>`exec:requests:${runId}:`;
const key=(runId:string,requestId:string)=>prefix(runId)+requestId;
const cancelled=(r:QueueRun)=>["cancel_requested","cancelled"].includes(r.view.status);
const active=(r:QueueRun,p:RequestRecord)=>!cancelled(r)&&!r.view.terminal&&r.view.threadId===p.threadId&&r.view.turnId===p.turnId;
const receipt=(r:ResponseRecord):ExecutionResponseReceipt=>({responseId:r.responseId,pendingRequestId:r.pendingRequestId,status:r.status});

// Owner responses have their own durable inbox. They never replace an execution
// command or change the batch/turn journal. Native wire IDs stay on the device.
export class ExecutionRequestInbox {
  constructor(private storage:DurableObjectStorage,private _env:Env) {}
  async stageEvent(r:QueueRun,event:RunnerEvent):Promise<Record<string,unknown>> {
    if(event.type==="turn.completed"&&event.turnId)
      return {[`exec:request-turn-ended:${r.view.runId}:${event.turnId}`]:true};
    if(event.type!=="approval.requested"&&event.type!=="input.requested"&&event.type!=="request.resolved")return {};
    check(event.threadId&&event.turnId,"交互请求缺少所属轮次。",400);
    check(new TextEncoder().encode(canonical(event.payload)).length<=32000,"审批或问题详情超过大小限制。",413);
    const requestKey=key(r.view.runId,event.payload.requestId),old=await this.storage.get<RequestRecord>(requestKey);
    if(event.type==="request.resolved") {
      if(!old)return {};
      check(old.threadId===event.threadId&&old.turnId===event.turnId,"请求结束轮次不一致。",409);
      old.state=event.payload.status;old.reason=event.payload.reason;
      const updates:Record<string,unknown>={[requestKey]:old};
      if(old.responseId) {
        const response=await this.storage.get<ResponseRecord>("exec:response:"+old.responseId);
        if(response&&response.status==="queued") {response.status=event.payload.status==="responded"?"applied":event.payload.status;delete response.response;updates["exec:response:"+old.responseId]=response;}
      }
      return updates;
    }
    check(!r.view.threadId||r.view.threadId===event.threadId,"交互请求不属于当前会话。",409);
    const request:RequestRecord={requestId:event.payload.requestId,runId:r.view.runId,threadId:event.threadId,turnId:event.turnId,state:"pending",...(r.view.turnId===event.turnId?{seenCurrent:true}:{}),...(event.type==="approval.requested"?{kind:"approval",description:event.payload.description,...(event.payload.details?{details:event.payload.details}:{})}:{kind:"input",questions:event.payload.questions})};
    if(old) {
      const identity=(v:RequestRecord)=>({...v,state:undefined,responseId:undefined,reason:undefined,seenCurrent:undefined});
      check(canonical(identity(old))===canonical(identity(request)),"请求编号已用于不同审批或问题。",409);return {};
    }
    const pending=await this.storage.list<RequestRecord>({prefix:prefix(r.view.runId),limit:1001});
    check(pending.size<1000,"运行交互请求已达上限。",409);
    return {[requestKey]:request};
  }
  private async current(r:QueueRun) {
    const records=await this.storage.list<RequestRecord>({prefix:prefix(r.view.runId),limit:1000});
    const current:RequestRecord[]=[];
    for(const p of records.values()) {
      if(!["pending","queued"].includes(p.state))continue;
      const ended=await this.storage.get<boolean>(`exec:request-turn-ended:${r.view.runId}:${p.turnId}`);
      if(active(r,p)&&!ended){
        if(!p.seenCurrent){p.seenCurrent=true;await this.storage.put(key(r.view.runId,p.requestId),p);}
        current.push(p);continue;
      }
      // Events can precede their report. A request from an as-yet unseen turn
      // is hidden until that report arrives, never expired merely by a GET.
      if(!cancelled(r)&&!ended&&!p.seenCurrent&&!(r.view.terminal&&r.view.turnId===p.turnId))continue;
      p.state=cancelled(r)?"cancelled":"expired";
      const updates:Record<string,unknown>={[key(r.view.runId,p.requestId)]:p};
      if(p.responseId) {
        const response=await this.storage.get<ResponseRecord>("exec:response:"+p.responseId);
        if(response&&response.status==="queued") {response.status=p.state;delete response.response;updates["exec:response:"+p.responseId]=response;}
      }
      await this.storage.put(updates);
    }
    return current;
  }
  async decorate(r:QueueRun,view:ExecutionRunView=r.view):Promise<ExecutionRunView> {
    const pending=await this.current(r);
    const {executionPermissions:_legacy,...base}=view;
    return {...base,...(r.snapshot.executionPermissions?{executionPermissions:r.snapshot.executionPermissions}:{}),pendingRequests:pending.map(({state,responseId:_responseId,reason:_reason,seenCurrent:_seen,...p})=>({...p,responseStatus:state as "pending"|"queued"}))};
  }
  async expire(r:QueueRun) {await this.current(r);}
  async respond(r:QueueRun,input:ExecutionRespond) {
    check(input.bindingId===r.principal.bindingId&&input.bindingRevision===r.principal.bindingRevision,"绑定已更改，请刷新后处理。",409);
    check(new TextEncoder().encode(canonical(input.response)).length<=64000,"回答超过大小限制。",413);
    const requestKey=key(r.view.runId,input.pendingRequestId),receiptKey=`exec:response-receipt:${r.principal.ownerId}:${input.requestId}`;
    const digest=await hash({principal:r.principal,input}),prior=await this.storage.get<string>(receiptKey);
    await this.current(r);
    if(prior) {
      const previous=await this.storage.get<ResponseRecord>("exec:response:"+prior);
      check(previous&&previous.hash===digest,"请求编号已用于不同回答。",409);return receipt(previous);
    }
    const request=await this.storage.get<RequestRecord>(requestKey);
    check(request&&request.runId===input.runId&&request.turnId===input.expectedTurnId&&active(r,request),"审批或问题已过期，或不属于当前轮次。",409);
    check(request.state==="pending","该请求已有回答，请等待设备处理。",409);
    if(request.kind==="approval") {
      check("decision" in input.response,"此请求需要审批决定。",400);
      check((request.details?.allowedDecisions??["decline","cancel"]).includes(input.response.decision),"此请求不允许该审批决定。",403);
    } else {
      check("answers" in input.response,"请逐项回答当前问题。",400);
      const answer=input.response.answers,questions=request.questions!;
      check(Object.keys(answer).length===questions.length&&questions.every(q=>Object.hasOwn(answer,q.id)),"回答必须与当前问题逐项对应。",400);
      for(const q of questions)if(q.options?.length&&!q.isOther)
        check(answer[q.id].answers.every(v=>q.options!.some(o=>o.label===v)),"请选择该问题提供的选项。",400);
    }
    const response:ResponseRecord={responseId:crypto.randomUUID(),pendingRequestId:request.requestId,runId:r.view.runId,threadId:request.threadId,turnId:request.turnId,response:input.response,status:"queued",hash:digest,requestId:input.requestId};
    request.state="queued";request.responseId=response.responseId;
    await this.storage.put({[requestKey]:request,[receiptKey]:response.responseId,["exec:response:"+response.responseId]:response});
    return receipt(response);
  }
  async poll(r:QueueRun) {
    const pending=await this.current(r),responses:NativeRequestResponse[]=[];
    for(const p of pending)if(p.responseId) {
      const response=await this.storage.get<ResponseRecord>("exec:response:"+p.responseId);
      if(response?.status==="queued"&&response.response)responses.push({responseId:response.responseId,pendingRequestId:p.requestId,runId:r.view.runId,threadId:p.threadId,turnId:p.turnId,response:response.response});
    }
    return {responses};
  }
  async acknowledge(r:QueueRun,input:NativeResponseAck) {
    await this.current(r);
    const response=await this.storage.get<ResponseRecord>("exec:response:"+input.responseId);
    check(response&&response.runId===r.view.runId,"回答不属于此运行。",403);
    if(response.status!=="queued") {
      check(response.status===input.status||["cancelled","expired"].includes(response.status),"回答处理回执冲突。",409);return {ok:true};
    }
    response.status=input.status;response.reason=input.reason;delete response.response;
    const request=await this.storage.get<RequestRecord>(key(r.view.runId,response.pendingRequestId));
    check(request&&request.responseId===response.responseId,"当前回答记录已更改。",409);
    request.state=input.status==="applied"?"responded":input.status;request.reason=input.reason;
    await this.storage.put({["exec:response:"+response.responseId]:response,[key(r.view.runId,request.requestId)]:request});return {ok:true};
  }
}
