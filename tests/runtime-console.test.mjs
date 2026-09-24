import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConsoleServer, parseOptions, resolveRunningPackage, runtimeInfo, rollbackTargets, snapshot } from '../ops/runtime-console.mjs';
import { switchRuntime } from '../ops/runtime-rollback.mjs';

const fixture=()=>{
  const root=mkdtempSync(path.join(tmpdir(),'devspace-console-'));
  const declared=path.join(root,'runtime-local13','node_modules','@waishnav','devspace');
  const actual=path.join(root,'runtime-local13-candidate','node_modules','@waishnav','devspace');
  for(const dir of [declared,actual]){
    mkdirSync(path.join(dir,'dist'),{recursive:true});
    writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:'1.1.0-beta.4.local.13'}));
    writeFileSync(path.join(dir,'dist','server.js'),'actual server build');
    writeFileSync(path.join(dir,'dist','cli.js'),'cli');
  }
  return {root,declared,actual,clean:()=>rmSync(root,{recursive:true,force:true})};
};
test('parsing rejects invalid service units and ports',()=>{
  assert.throws(()=>parseOptions(['--serve','99999']),/Invalid --serve/);
  assert.throws(()=>parseOptions(['--service-unit','../evil']),/Invalid service unit/);
  assert.throws(()=>parseOptions(['--pid','abc']),/Invalid --pid/);
  assert.equal(parseOptions(['--instance','server','--serve','17678']).serve,17678);
});
test('runtime identity distinguishes configured pointer from actual running process',()=>{
  const f=fixture();
  try{
    const options={platformRoot:f.root,explicitRuntimePackage:f.declared,serviceUnit:'',runtimeManifest:'',controlManifest:'',processOverride:{pid:1234,packageRoot:f.actual,evidence:'test process cmdline'}};
    const info=runtimeInfo(options);
    assert.equal(info.version,'1.1.0-beta.4.local.13');
    assert.equal(info.actual.package_root,f.actual);
    assert.equal(info.package_root,f.declared);
    assert.equal(info.actual.pid,1234);
    assert.equal(info.pointer_mismatch,true);
    assert.equal(info.hashes_equal,true);
    assert.equal(info.provenance.runtime,null);
    assert.equal(info.provenance.evidence,'not recorded or not verified');
    const checksum=createHash('sha256').update('actual server build').digest('hex');
    writeFileSync(path.join(f.actual,'runtime-provenance.json'),JSON.stringify({git_commit:'c'.repeat(40),git_branch:'runtime/beta4-unified',server_sha256:checksum}));
    assert.equal(runtimeInfo(options).provenance.runtime.git_commit,'c'.repeat(40));
    writeFileSync(path.join(f.actual,'runtime-provenance.json'),JSON.stringify({git_commit:'c'.repeat(40)}));
    assert.equal(runtimeInfo(options).provenance.runtime,null,'Git commit without a matching artifact hash is not verified');
    writeFileSync(path.join(f.actual,'runtime-provenance.json'),JSON.stringify({git_commit:'d'.repeat(40),server_sha256:'e'.repeat(64)}));
    assert.equal(runtimeInfo(options).provenance.runtime,null,'stale manifests must fail closed');
  }finally{f.clean();}
});
test('CLI package discovery does not accept unrelated process arguments',()=>{
  const f=fixture();
  try{
    const cli=path.join(f.actual,'dist','cli.js');
    assert.equal(resolveRunningPackage(['node',cli,'serve']),f.actual);
    assert.equal(resolveRunningPackage(['node',path.join(f.root,'other','cli.js')]),'');
    assert.equal(resolveRunningPackage(['node','--flag','/tmp/password']), '');
  }finally{f.clean();}
});
test('snapshot never includes owner secrets and does not mislabel missing Git provenance',async()=>{
  const f=fixture();
  try{
    const config=path.join(f.root,'config.jsonc');
    writeFileSync(config,JSON.stringify({server:{host:'127.0.0.1',port:1,publicBaseUrl:'https://example.invalid/server'},storage:{stateDir:path.join(f.root,'state')},oauth:{ownerToken:'NEVER_SHOW_THIS'}}));
    const x=await snapshot({instance:'server',platformRoot:f.root,configPath:config,explicitRuntimePackage:f.declared,serviceUnit:'',tunnelUnit:'',tunnelMetrics:'',stateDir:'',runtimeManifest:'',controlManifest:''});
    assert.equal(x.schema_version,2);
    assert.equal(x.runtime.actual.package_root,null);
    assert.equal(x.runtime.provenance.runtime,null);
    assert.equal(x.security.credentials_included,false);
    assert.equal(JSON.stringify(x).includes('NEVER_SHOW_THIS'),false);
  }finally{f.clean();}
});
test('read-only inventory uses the deployed devspace.sqlite and jobs schema',async()=>{
  const f=fixture();
  try{
    const {DatabaseSync}=await import('node:sqlite');
    const state=path.join(f.root,'state');
    mkdirSync(path.join(state,'jobs'),{recursive:true});
    const db=new DatabaseSync(path.join(state,'devspace.sqlite'));
    db.exec('create table workspace_sessions(id text,root text,status text,mode text,last_used_at integer);');
    db.exec('create table workflow_sessions(id text,workspace_root text,workspace_mode text,status text,task_intent text,review_ref text,updated_at integer);');
    db.prepare('insert into workspace_sessions values(?,?,?,?,?)').run('ws1','/example','active','checkout',100);
    db.prepare('insert into workflow_sessions values(?,?,?,?,?,?,?)').run('wf1','/example','checkout','completed','test intent','ref1',200);
    db.close();
    const jobs=new DatabaseSync(path.join(state,'jobs','jobs.sqlite'));
    jobs.exec('create table durable_jobs(id text,workspace_id text,workspace_root text,working_directory text,pid integer,status text,created_at integer,exit_code integer,error text);');
    jobs.prepare('insert into durable_jobs values(?,?,?,?,?,?,?,?,?)').run('job1','ws1','/example','/example',5,'completed',100,0,null);
    jobs.close();
    const config=path.join(f.root,'config.jsonc');
    writeFileSync(config,JSON.stringify({server:{host:'127.0.0.1',port:1,publicBaseUrl:'https://example.invalid/server'},storage:{stateDir:state}}));
    const info=await snapshot({instance:'server',platformRoot:f.root,configPath:config,explicitRuntimePackage:f.declared,serviceUnit:'',tunnelUnit:'',tunnelMetrics:'',stateDir:state,runtimeManifest:'',controlManifest:''});
    assert.equal(info.inventory.available,true,info.inventory.error);
    assert.deepEqual([info.inventory.workspace_count,info.inventory.workflow_session_count,info.inventory.job_count],[1,1,1]);
    assert.equal(info.inventory.workspaces[0].id,'ws1');
    assert.equal(info.inventory.workflow_sessions[0].id,'wf1');
    assert.equal(info.inventory.jobs[0].id,'job1');
  }finally{f.clean();}
});
test('web UI serves separate local-only assets, bounded status, and protects actions',async()=>{
  const calls=[];
  const options={serve:0,serviceUnit:'devspace-control-server.service',tunnelUnit:'devspace-server-cloudflared.service'};
  const server=createConsoleServer(options,{snapshot:async()=>({schema_version:2,instance:'server',runtime:{version:'test'},security:{credentials_included:false}}),restart:(unit)=>{calls.push(unit);return {ok:true,status:200,unit};}});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const home=await fetch(base+'/');
    assert.equal(home.status,200);
    assert.match(await home.text(),/Control Console/);
    assert.match(home.headers.get('content-security-policy'),/default-src 'none'/);
    assert.equal((await fetch(base+'/ui.css')).status,200);
    assert.equal((await fetch(base+'/ui.js')).status,200);
    const status=await fetch(base+'/api/status');
    assert.equal((await status.json()).runtime.version,'test');
    assert.equal(status.headers.get('cache-control'),'no-store');
    const denied=await fetch(base+'/api/actions/restart-devspace',{method:'POST'});
    assert.equal(denied.status,403);
    const token=(await (await fetch(base+'/api/action-token')).json()).token;
    const wrongOrigin=await fetch(base+'/api/actions/restart-devspace',{method:'POST',headers:{'x-devspace-console-token':token,origin:'https://attacker.invalid'}});
    assert.equal(wrongOrigin.status,403);
    const unknown=await fetch(base+'/api/actions/not-real',{method:'POST',headers:{'x-devspace-console-token':token,origin:base}});
    assert.equal(unknown.status,404);
    const ok=await fetch(base+'/api/actions/restart-devspace',{method:'POST',headers:{'x-devspace-console-token':token,origin:base}});
    assert.equal(ok.status,200);
    assert.equal((await fetch(base+'/api/actions/restart-devspace',{method:'POST',headers:{'x-devspace-console-token':token}})).status,403);
    assert.deepEqual(calls,['devspace-control-server.service']);
  }finally{await new Promise((resolve)=>server.close(resolve));}
});
test('connection URL is public and credential is omitted from the routine snapshot',async()=>{
  const f=fixture();
  try{
    const config=path.join(f.root,'config.jsonc');
    writeFileSync(config,JSON.stringify({server:{host:'127.0.0.1',port:17677,publicBaseUrl:'https://example.invalid/server'}}));
    const x=await snapshot({instance:'server',platformRoot:f.root,configPath:config,explicitRuntimePackage:f.declared,serviceUnit:'',tunnelUnit:'',tunnelMetrics:'',stateDir:'',runtimeManifest:'',controlManifest:'',allowOwnerCopy:false,credentialFile:''});
    assert.equal(x.connection.public_mcp_url,'https://example.invalid/server/mcp');
    assert.equal(x.connection.local_mcp_url,'http://127.0.0.1:17677/server/mcp');
    assert.equal(x.connection.owner_copy_available,false);
    assert.equal(JSON.stringify(x).includes('ownerToken'),false);
  }finally{f.clean();}
});
test('operator password requires explicit enablement, same origin and per-process token',async()=>{
  const options={serve:0,serviceUnit:'',tunnelUnit:'',allowOwnerCopy:true,credentialFile:'/fixture/owner.json'};
  const server=createConsoleServer(options,{snapshot:async()=>({schema_version:2,security:{credentials_included:false}}),getOperatorPassword:()=> 'fake-test-owner-password-only'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/api/credentials/owner',{method:'POST'})).status,403);
    const status=await (await fetch(base+'/api/status')).text();
    assert.equal(status.includes('fake-test-owner-password-only'),false);
    const token=(await (await fetch(base+'/api/action-token')).json()).token;
    const wrong=await fetch(base+'/api/credentials/owner',{method:'POST',headers:{origin:'https://example.invalid','x-devspace-console-token':token}});
    assert.equal(wrong.status,403);
    const accepted=await fetch(base+'/api/credentials/owner',{method:'POST',headers:{origin:base,'x-devspace-console-token':token,'content-type':'application/json'},body:'{}'});
    assert.equal(accepted.status,200);
    assert.equal((await accepted.json()).password,'fake-test-owner-password-only');
    assert.equal(accepted.headers.get('cache-control'),'no-store');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('runtime rollback target inventory includes actual candidate and excludes damaged packages',()=>{
  const f=fixture();
  try{
    const rt=runtimeInfo({platformRoot:f.root,explicitRuntimePackage:f.declared,serviceUnit:'',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}});
    const candidates=rollbackTargets({platformRoot:f.root},rt);
    assert.deepEqual(candidates.map(x=>x.id),['runtime-local13','runtime-local13-candidate']);
    assert.equal(candidates[0].verified,true);
    assert.equal(candidates[0].current,false);
    assert.equal(candidates[1].current,true);
    mkdirSync(path.join(f.root,'runtime-local9'),{recursive:true});
    assert.equal(rollbackTargets({platformRoot:f.root},rt).length,2);
  }finally{f.clean();}
});
test('rollback API requires current process, exact inventory ID, hash, token and origin',async()=>{
  const f=fixture();
  const calls=[];
  const opts={serve:0,platformRoot:f.root,explicitRuntimePackage:f.declared,serviceUnit:'devspace-test.service',tunnelUnit:'',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}};
  const server=createConsoleServer(opts,{snapshot:async()=>({schema_version:2}),switchRuntime:async(args)=>{calls.push(args);return {ok:true,status:200,target_id:args.target.id};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try{
    const token=(await (await fetch(url+'/api/action-token')).json()).token;
    const target=rollbackTargets(opts,runtimeInfo(opts)).find(x=>!x.current);
    const body=JSON.stringify({target_id:target.id,expected_sha256:target.server_sha256,observed_pid:123});
    const post=(payload,headers={})=>fetch(url+'/api/actions/rollback-runtime',{method:'POST',headers:{origin:url,'x-devspace-console-token':token,'content-type':'application/json',...headers},body:payload});
    assert.equal((await post(body,{'x-devspace-console-token':'incorrect'})).status,403);
    assert.equal((await post(body,{origin:'https://external.invalid'})).status,403);
    assert.equal((await post(JSON.stringify({...JSON.parse(body),target_id:'../../anything'}))).status,409);
    assert.equal((await post(JSON.stringify({...JSON.parse(body),expected_sha256:'0'.repeat(64)}))).status,409);
    assert.equal((await post(JSON.stringify({...JSON.parse(body),observed_pid:124}))).status,409);
    assert.equal(calls.length,0);
    const good=await post(body);
    assert.equal(good.status,200);
    assert.equal((await good.json()).target_id,target.id);
    assert.equal(calls.length,1);
    assert.equal(calls[0].target.id,target.id);
  }finally{await new Promise(resolve=>server.close(resolve));f.clean();}
});
test('selected runtime switch validates identity and restores launcher on failed health',async()=>{
  const f=fixture();
  try{
    const bin=path.join(f.root,'bin');mkdirSync(bin,{recursive:true});
    const wrapper=path.join(bin,'run-devspace');
    const original='#!/bin/sh\nexec "node" '+JSON.stringify(path.join(f.actual,'dist','cli.js'))+' serve\n';
    writeFileSync(wrapper,original,{mode:0o700});
    const rt=runtimeInfo({platformRoot:f.root,explicitRuntimePackage:f.declared,serviceUnit:'',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}});
    const target=rollbackTargets({platformRoot:f.root},rt).find(x=>!x.current);
    const params={options:{platformRoot:f.root,serviceUnit:'test-runtime.service'},live:rt.actual,target,expectedHash:target.server_sha256,observedPid:123,platform:'linux'};
    assert.equal((await switchRuntime({...params,expectedHash:'0'.repeat(64)})).status,409);
    assert.equal(readFileSync(wrapper,'utf8'),original);
    let restarts=0;
    const failed=await switchRuntime({
      ...params,restart:()=>{restarts++;},
      probe:async(candidate)=>candidate.package_root===f.actual,
      probeAttempts:2,probeIntervalMs:1
    });
    assert.equal(failed.status,500);
    assert.equal(failed.restored,true);
    assert.equal(restarts,2);
    assert.equal(readFileSync(wrapper,'utf8'),original);
    const ok=await switchRuntime({...params,restart:()=>{},probe:async()=>true,probeAttempts:2,probeIntervalMs:1});
    assert.equal(ok.status,200);
    assert.match(readFileSync(wrapper,'utf8'),/runtime-local13[\\/]/);
    assert.equal(readFileSync(path.join(f.root,'state','runtime-rollback',ok.backup_id+'.run-devspace.bak'),'utf8'),original);
  }finally{f.clean();}
});
test('UI includes semantic navigation, theme/language controls, responsive and accessible states',()=>{
  const html=readFileSync(new URL('../ops/runtime-console-ui.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../ops/runtime-console-ui.css',import.meta.url),'utf8');
  const js=readFileSync(new URL('../ops/runtime-console-ui.js',import.meta.url),'utf8');
  for(const id of ['overview','access','runtime','connectivity','requests','activity','deployment'])assert.match(html,new RegExp('data-view="'+id+'"'));
  for(const id of ['language','theme-toggle','confirm-dialog','request-filter'])assert.match(html+js,new RegExp(id));
  assert.match(html,/skip-link/);
  assert.match(css,/@media\(max-width:520px\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/:focus-visible/);
  assert.match(js,/pointerMismatch/);
  assert.match(js,/noManifest/);
  assert.match(js,/data-copy-owner/);
  assert.match(js,/rollback-confirm-input/);
});
