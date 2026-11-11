import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root=path.resolve("."),temp=path.join(root,".tmp");
await mkdir(temp,{recursive:true});
const suite=await mkdtemp(path.join(temp,"runner-interaction-ledger-"));
assert.ok(suite.startsWith(temp+path.sep));
test.after(()=>rm(suite,{recursive:true,force:true}));
await build({entryPoints:["runner/execution-store.ts"],bundle:true,platform:"node",format:"esm",packages:"external",outfile:path.join(suite,"api.mjs"),logLevel:"silent"});
const {ExecutionStore}=await import(pathToFileURL(path.join(suite,"api.mjs")).href);

const response=(overrides={})=>({responseId:"response-a",pendingRequestId:"request-a",runId:"run-a",threadId:"thread-a",turnId:"turn-a",response:{decision:"decline"},...overrides});
async function fixture(t) {
  const dir=await mkdtemp(path.join(suite,"case-")),filename=path.join(dir,"execution.sqlite");
  let store=new ExecutionStore(filename);
  t.after(()=>store.close());
  return {filename,get store(){return store;},reopen(){store.close();store=new ExecutionStore(filename);return store;}};
}

test("response IDs bind the entire run/thread/turn/request identity and decision",async t=>{
  const f=await fixture(t),input=response();
  const first=f.store.beginInteractionResponse(input);
  assert.equal(first.created,true);assert.equal(first.receipt.status,"dispatching");
  assert.deepEqual(f.store.beginInteractionResponse(structuredClone(input)),{created:false,receipt:first.receipt});
  for(const change of [{runId:"other-run"},{threadId:"other-thread"},{turnId:"other-turn"},{pendingRequestId:"other-request"},{response:{decision:"accept"}}])
    assert.throws(()=>f.store.beginInteractionResponse({...input,...change}),e=>e.code==="IDEMPOTENCY_KEY_REUSED");
  assert.equal(f.store.unackedInteractionResponses().length,1);
});

test("a crash after the dispatching fence cannot create a second wire-response attempt",async t=>{
  const f=await fixture(t),input=response();
  f.store.beginInteractionResponse(input);
  f.reopen();
  assert.equal(f.store.unackedInteractionResponses()[0].status,"dispatching");
  assert.equal(f.store.beginInteractionResponse(input).created,false);
  // Runner startup expires this uncertain send instead of sending the answer
  // again. A replay remains fenced after expiry and acknowledgement as well.
  f.store.finishInteractionResponse(input.responseId,"expired");
  f.store.acknowledgeInteractionResponse(input.responseId);
  f.reopen();
  assert.deepEqual(f.store.unackedInteractionResponses(),[]);
  const replay=f.store.beginInteractionResponse(input);
  assert.equal(replay.created,false);assert.equal(replay.receipt.status,"expired");assert.equal(replay.receipt.acked,true);
});

test("applied and cancelled receipts survive lost acknowledgements without retaining answer text",async t=>{
  const f=await fixture(t),secret="ledger-private-fixture-answer-never-persist-2026";
  const input=response({response:{answers:{question:{answers:[secret]}}}});
  const first=f.store.beginInteractionResponse(input);
  assert.deepEqual(Object.keys(first.receipt).sort(),["responseId","pendingRequestId","runId","hash","status","acked"].sort());
  f.store.finishInteractionResponse(input.responseId,"applied");
  const cancelled=response({responseId:"response-cancelled",pendingRequestId:"request-cancelled"});
  f.store.beginInteractionResponse(cancelled);f.store.finishInteractionResponse(cancelled.responseId,"cancelled");
  f.reopen();
  assert.deepEqual(f.store.unackedInteractionResponses().map(r=>r.status).sort(),["applied","cancelled"]);
  assert.equal(f.store.beginInteractionResponse(input).created,false);
  for(const suffix of ["","-wal","-shm"]) {
    const bytes=await readFile(f.filename+suffix).catch(()=>Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(secret)),false,"answer body must not exist in SQLite or its journals");
  }
  for(const entry of f.store.unackedInteractionResponses())f.store.acknowledgeInteractionResponse(entry.responseId);
  f.reopen();assert.deepEqual(f.store.unackedInteractionResponses(),[]);
});

test("ack retry pages remain bounded and each receipt retires independently",async t=>{
  const f=await fixture(t);
  for(let i=0;i<25;i++){const input=response({responseId:`response-${i}`});f.store.beginInteractionResponse(input);f.store.finishInteractionResponse(input.responseId,"applied");}
  const first=f.store.unackedInteractionResponses();assert.equal(first.length,20);
  for(const row of first){f.store.acknowledgeInteractionResponse(row.responseId);f.store.acknowledgeInteractionResponse(row.responseId);}
  f.reopen();const second=f.store.unackedInteractionResponses();assert.equal(second.length,5);
  assert.equal(second.some(row=>first.some(old=>old.responseId===row.responseId)),false);
});
