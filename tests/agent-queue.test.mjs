import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
Error.stackTraceLimit = 1;
const b = await build({entryPoints:['worker/execution/batch-queue.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const { BatchQueue, initialQueue } = await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
function fixture({human=false,autoComplete=true}={}) {
  const data=new Map(); let finalize=0; let conflict=false; let down=false;
  const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>{for(const [a,b] of typeof k==='string'?[[k,v]]:Object.entries(k))data.set(a,structuredClone(b));},delete:async k=>data.delete(k),list:async({prefix='' }={})=>new Map([...data].filter(([k])=>k.startsWith(prefix))),setAlarm:async()=>{}};
  const principal={ownerId:'alice',runnerId:'runner',bindingId:'binding',bindingRevision:1,authEpoch:1};
  const items=[0,1,2].map(i=>({taskId:'task'+i,text:'task'+i,instruction:'write '+i,acceptance:[{id:'check'+i,description:'result',required:true,...(human?{kind:'human'}:{kind:'artifact',relativePath:i+'.txt',predicate:{type:'exists'}})}],source:{taskRef:{canvasId:'canvas',noteId:'note',taskId:'task'+i},generation:1,specRevision:1}}));
  const run={principal,snapshot:{kind:'task',runId:'run',batch:{managed:true,autoComplete,items}},view:{runId:'run',bindingId:'binding',status:'running',threadId:'thread',turnId:'turn0',reportRevision:1,commandId:'command',terminal:false,stopConfirmed:false,batch:{currentIndex:0,items:items.map((x,i)=>({taskId:x.taskId,text:x.text,status:i?'pending':'done',summary:'ok',...(i?{}:{completedTurnId:'turn0'})}))}},queueState:initialQueue()};
  const env={ROOMS:{idFromName:x=>x,get:()=>({fetch:async(_u,init)=>{const v=JSON.parse(init.body).input;if(v.action==='validate'){if(conflict)return new Response('changed',{status:409});return Response.json({items:items.filter(x=>v.tasks.some(t=>t.taskId===x.taskId))});}if(v.action==='finalize'){finalize++;if(down)return new Response('offline',{status:503});return Response.json({status:'applied'});}throw Error(v.action);}})}};
  env.DB={prepare:sql=>({bind(){return this;},async first(){return sql.includes('agent_bindings')?{canvas_id:'canvas',workspace_id:'workspace'}:{workspaces_json:JSON.stringify([{workspaceId:'workspace'}])};}})};
  const q=new BatchQueue(storage,env);
  const proof=async(index=0,{status='passed',failureKind,turnId='turn'+index}={})=>{await storage.put('exec:queue-proof:run:'+turnId+':turn.completed',{threadId:'thread',turnId,type:'turn.completed',payload:{status:'completed',outcome:{runId:'run',taskId:'task'+index,outcome:'done'}}});await storage.put('exec:queue-proof:run:'+turnId+':verification.completed',{threadId:'thread',turnId,type:'verification.completed',payload:{results:[{criterionId:'check'+index,status:human?'needs_input':status,evidenceRefs:['native:artifact'],outputHash:'a'.repeat(64),...(failureKind?{failureKind}:{})}]}});};
  const gate=()=>q.gate(run,{runId:'run',commandId:'command',fromIndex:run.view.batch.currentIndex,completedTurnId:run.view.turnId,reportRevision:run.view.reportRevision,connectionEpoch:1});
  const control=(action,extra={})=>q.control(run,{bindingId:'binding',bindingRevision:1,runId:'run',requestId:crypto.randomUUID(),expectedRevision:run.view.queue?.revision??1,action,...extra});
  return {run,q,proof,gate,control,storage,get finalize(){return finalize;},conflict(){conflict=true;},down(v=true){down=v;}};
}
test('managed queue refuses model-only done, then advances only after real proof and exact writeback',async()=>{
  const f=fixture(); assert.equal((await f.gate()).decision,'wait');assert.equal(f.finalize,0);
  await f.proof();const g=await f.gate();assert.equal(g.decision,'advance');assert.equal(g.nextIndex,1);assert.equal(f.finalize,1);
  assert.deepEqual(await f.gate(),g);assert.equal(f.finalize,1);
});
test('human criterion needs explicit turn+revision CAS and cannot be satisfied by native passed',async()=>{
  const f=fixture({human:true});await f.proof();assert.equal((await f.gate()).decision,'wait');assert.equal(f.run.view.queue.phase,'waiting_human');assert.equal(f.finalize,0);
  await assert.rejects(f.control('confirm',{expectedTurnId:'old'}));
  await f.control('confirm',{expectedTurnId:'turn0'});assert.equal((await f.gate()).decision,'advance');assert.equal(f.finalize,1);
});
test('pause waits for current verification/writeback, resume admits next same item once',async()=>{
  const f=fixture();await f.control('pause');await f.proof();assert.equal((await f.gate()).decision,'wait');assert.equal(f.run.view.queue.phase,'paused');assert.equal(f.finalize,1);
  await f.control('resume');assert.equal((await f.gate()).decision,'advance');assert.equal(f.finalize,1);
});
test('writeback outage and pending specification conflict never admit next',async()=>{
  const f=fixture();f.down();await f.proof();assert.equal((await f.gate()).decision,'wait');assert.equal(f.run.view.queue.phase,'finalizing');
  const c=fixture();c.conflict();await c.proof();assert.equal((await c.gate()).decision,'blocked');assert.equal(c.finalize,0);
});
test('only predicate or exit failure gets a single durable repair permit',async()=>{
  const f=fixture();await f.proof(0,{status:'failed',failureKind:'predicate'});const g=await f.gate();assert.equal(g.decision,'repair');assert.deepEqual(await f.gate(),g);assert.equal(f.finalize,0);
  const bad=fixture();await bad.proof(0,{status:'failed',failureKind:'access_denied'});assert.equal((await bad.gate()).decision,'blocked');
  assert.equal(g.nextIndex,0);
  const changed=fixture();changed.conflict();await changed.proof(0,{status:'failed',failureKind:'predicate'});assert.equal((await changed.gate()).decision,'blocked');assert.equal(changed.run.view.queue.repairCount,0);
});
test('last item also waits for acceptance and writeback before finish',async()=>{
  const f=fixture();f.run.view.batch.currentIndex=2;f.run.view.turnId='turn2';f.run.view.batch.items[2]={...f.run.view.batch.items[2],status:'done',completedTurnId:'turn2'};f.run.queueState.index=2;
  f.run.queueState.pauseRequested=true;
  assert.equal((await f.gate()).decision,'wait');await f.proof(2);assert.equal((await f.gate()).decision,'finish');assert.equal(f.finalize,1);
});
