import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, symlink, rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const scratch=await mkdtemp(path.resolve('.tmp/interaction-metadata-'));
const root=path.join(scratch,'project');
await mkdir(root);
const bundle=path.join(scratch,'metadata.mjs');
await build({entryPoints:['runner/interaction-metadata.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const {approvalMetadata,inputMetadata}=await import(pathToFileURL(bundle));
test.after(()=>rm(scratch,{recursive:true,force:true}));
const run={root,snapshot:{kind:'task',executionPermissions:{profile:'workspace_manual',network:false}}};
const command='item/commandExecution/requestApproval',file='item/fileChange/requestApproval';
const denied=metadata=>assert.deepEqual(metadata.details.allowedDecisions,['decline','cancel']);

test('approval metadata fits the cloud byte envelope even for multibyte paths',()=>{
  const result=approvalMetadata(run,file,{command:'中'.repeat(7900),reason:'原'.repeat(1800)},{files:Array.from({length:30},(_,i)=>`目录${i}/`+'文'.repeat(460))});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<24000);
  denied(result);assert.equal(result.details.command,undefined);assert.equal(result.details.files,undefined);
});
test('approval never treats a junction under project as an authorized target',async()=>{
  const outside=path.join(scratch,'outside');await mkdir(outside);
  const link=path.join(root,'link');await symlink(outside,link,process.platform==='win32'?'junction':'dir');
  denied(approvalMetadata(run,file,{}, {files:[path.join(link,'new.txt')]}));
  denied(approvalMetadata(run,command,{command:'echo test',cwd:link}));
  assert.ok(approvalMetadata(run,file,{}, {files:[path.join(root,'new.txt')]}).details.allowedDecisions.includes('accept'));
});
test('stdin approval cannot be approved from the parent command display',()=>{
  denied(approvalMetadata(run,command,{kind:'writeStdin',command:'node',cwd:root}));
});
test('question labels retain exact identity or reject before presentation',()=>{
  const q={id:'q',question:'请选择',isOther:false,options:[{label:'一',description:'第一项'},{label:'二',description:'第二项'}]};
  assert.deepEqual(inputMetadata([q])[0].options,q.options);
  assert.throws(()=>inputMetadata([{...q,options:[{label:'token=private-value',description:''}]}]));
  assert.throws(()=>inputMetadata([{...q,options:[q.options[0],q.options[0]]}]));
});
test('read-only and session/network/extra filesystem requests cannot be approved',()=>{
  denied(approvalMetadata({...run,snapshot:{kind:'task',executionPermissions:{profile:'read_only',network:false}}},file,{}, {files:['new.txt']}));
  for(const extra of [{grantRoot:root},{networkApprovalContext:{host:'example.com'}},{additionalPermissions:{network:{enabled:true}}},{additionalPermissions:{fileSystem:{write:[scratch]}}}])
    denied(approvalMetadata(run,command,{command:'echo test',cwd:root,...extra}));
});
test('sensitive values are removed from visible command details',()=>{
  const result=approvalMetadata(run,command,{command:'tool --token test-secret --password another-secret',cwd:root});
  assert.ok(!result.details.command.includes('test-secret'));
  assert.ok(!result.details.command.includes('another-secret'));
  assert.match(result.details.command,/REDACTED/);
});
