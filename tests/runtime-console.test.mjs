import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConsoleServer, parseOptions, resolveRunningPackage, runtimeInfo, rollbackTargets, snapshot } from '../ops/runtime-console.mjs';
import { switchRuntime } from '../ops/runtime-rollback.mjs';
import { buildCloudflaredArgs, quickTunnelOriginFromText } from '../ops/managed-cloudflared.mjs';
import {
  configHistoryItem, importLegacyQuickConfigCandidate, managementPublicBaseUrl,
  projectChoices, projectDetails, observeProject, restoreConfigHistory, rollbackReview, updateManagedConfig
} from '../ops/control-management.mjs';

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
test('Control provenance verifies the deployed UI files, not just the backend script',()=>{
  const f=fixture();
  try{
    const bin=path.join(f.root,'bin');
    mkdirSync(bin,{recursive:true});
    const backend='control backend';
    writeFileSync(path.join(bin,'runtime-console.mjs'),backend);
    const assets=['runtime-console-ui.css','runtime-console-ui.html','runtime-console-ui.js'];
    const digest=(s)=>createHash('sha256').update(s).digest('hex');
    const ui_sha256=Object.fromEntries(assets.map((name)=>{
      writeFileSync(path.join(bin,name),name);
      return [name,digest(name)];
    }));
    const controlManifest=path.join(f.root,'control-provenance.json');
    const entry={git_commit:'a'.repeat(40),server_sha256:digest(backend),ui_sha256};
    writeFileSync(controlManifest,JSON.stringify(entry));
    const options={platformRoot:f.root,explicitRuntimePackage:f.declared,serviceUnit:'',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}};
    assert.equal(runtimeInfo(options).provenance.control.ui_manifest_verified,true);
    writeFileSync(controlManifest,JSON.stringify({...entry,ui_sha256:null}));
    assert.equal(runtimeInfo(options).provenance.control,null,'an explicitly malformed UI manifest must not be treated as legacy');
    writeFileSync(controlManifest,JSON.stringify({...entry,ui_sha256:{...ui_sha256,'runtime-console-ui.js':undefined}}));
    assert.equal(runtimeInfo(options).provenance.control,null,'a declared UI manifest must contain all three hashes');
    writeFileSync(controlManifest,JSON.stringify(entry));
    writeFileSync(controlManifest,JSON.stringify({...entry,source_dirty:true}));
    assert.equal(runtimeInfo(options).provenance.control,null,'a dirty source cannot attest an exact Git revision');
    writeFileSync(controlManifest,JSON.stringify(entry));
    writeFileSync(path.join(bin,assets[0]),'changed UI after packaging');
    assert.equal(runtimeInfo(options).provenance.control,null,'a mismatched UI asset must invalidate source provenance');
    writeFileSync(controlManifest,JSON.stringify({git_commit:entry.git_commit,server_sha256:entry.server_sha256}));
    assert.equal(runtimeInfo(options).provenance.control.ui_manifest_verified,false,'legacy manifests only attest the backend');
  }finally{f.clean();}
});
test('provenance writer includes UI hashes in the frozen artifact',()=>{
  const f=fixture();
  try{
    const bin=path.join(f.root,'ops');
    mkdirSync(bin,{recursive:true});
    writeFileSync(path.join(bin,'runtime-console.mjs'),'control backend');
    for(const name of ['runtime-console-ui.css','runtime-console-ui.html','runtime-console-ui.js'])writeFileSync(path.join(bin,name),name);
    const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const output=path.join(f.root,'control-provenance.json');
    const result=spawnSync(process.execPath,[path.join(repo,'ops','write-provenance.mjs'),'--source-root',repo,
      '--server-file',path.join(bin,'runtime-console.mjs'),'--ui-dir',bin,'--package-file',path.join(repo,'package.json'),'--output',output],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const manifest=JSON.parse(readFileSync(output,'utf8'));
    for(const name of ['runtime-console-ui.css','runtime-console-ui.html','runtime-console-ui.js'])
      assert.equal(manifest.ui_sha256[name],createHash('sha256').update(name).digest('hex'));
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
    assert.equal(x.management.settings.tunnel_mode,'Remote');
    assert.equal(x.management.settings.public_base_url,'https://example.invalid/server');
    assert.ok(Array.isArray(x.management.projects));
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
test('managed config save preserves unrelated config and creates a restorable history snapshot',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'devspace-managed-config-'));
  try{
    const project=path.join(root,'project');mkdirSync(project);
    const config=path.join(root,'config','config.jsonc');mkdirSync(path.dirname(config),{recursive:true});
    const original={configVersion:1,server:{host:'127.0.0.1',port:17677,publicBaseUrl:'https://example.invalid/server'},workspaces:{allowedRoots:[root],worktreeRoot:path.join(root,'worktrees')},tools:{mode:'codex'},ui:{enabled:true},skills:{enabled:true,paths:[]},logging:{level:'info',format:'json',requests:true,toolCalls:true,shellCommands:false},oauth:{scopes:['devspace'],sentinel:'KEEP'}};
    writeFileSync(config,JSON.stringify(original));
    const result=updateManagedConfig({platformRoot:root,configPath:config,serve:17678},{allowed_roots:[project],tool_mode:'claude',logging:{level:'debug',shell_commands:true}});
    assert.equal(result.ok,true);
    const next=JSON.parse(readFileSync(config,'utf8'));
    assert.deepEqual(next.oauth,original.oauth);
    assert.deepEqual(next.workspaces.allowedRoots,[project]);
    assert.equal(next.tools.mode,'claude');
    assert.equal(next.logging.level,'debug');
    assert.equal(next.logging.shellCommands,true);
    const history=path.join(root,'state','config-history-web',result.history);
    assert.equal(JSON.parse(readFileSync(history,'utf8')).tools.mode,'codex');
    const historyItem=configHistoryItem({platformRoot:root,configPath:config},result.history);
    assert.equal(historyItem.control.tunnel_mode,'Remote');
    assert.equal(historyItem.control.remote_public_base_url,'https://example.invalid/server');

    const quick=updateManagedConfig(
      {platformRoot:root,configPath:config,serve:17678},
      {tunnel_mode:'Quick',public_base_url:'https://example.invalid/server'}
    );
    assert.equal(quick.control.tunnel_mode,'Quick');
    assert.equal(JSON.parse(readFileSync(config,'utf8')).server.publicBaseUrl,null);
    const controlFile=path.join(root,'control-settings.json');
    assert.equal(JSON.parse(readFileSync(controlFile,'utf8')).tunnel_mode,'Quick');
    mkdirSync(path.join(root,'state'),{recursive:true});
    writeFileSync(path.join(root,'state','quick-tunnel-url.txt'),'https://fixture-quick.trycloudflare.com\n');
    assert.equal(managementPublicBaseUrl({platformRoot:root,configPath:config}),'https://fixture-quick.trycloudflare.com/server');

    const beforeQuick=configHistoryItem({platformRoot:root,configPath:config},quick.history);
    assert.equal(beforeQuick.control.tunnel_mode,'Remote');
    const restored=restoreConfigHistory({platformRoot:root,configPath:config},quick.history);
    assert.equal(restored.ok,true);
    assert.equal(JSON.parse(readFileSync(config,'utf8')).server.publicBaseUrl,'https://example.invalid/server');
    assert.equal(JSON.parse(readFileSync(controlFile,'utf8')).tunnel_mode,'Remote');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('Quick effective config uses generated origin, preserves route prefix and never mutates canonical config',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'devspace-quick-config-'));
  try{
    const configRoot=path.join(root,'config');
    const configDir=path.join(configRoot,'devspace');
    const state=path.join(root,'state');
    const effective=path.join(state,'quick-effective-config');
    mkdirSync(configDir,{recursive:true});mkdirSync(state,{recursive:true});
    const canonical={
      configVersion:1,
      server:{host:'127.0.0.1',port:17677,publicBaseUrl:null,allowedHosts:['localhost','127.0.0.1','dev.sanqi.org'],trustProxy:false},
      workspaces:{allowedRoots:[root]},storage:{stateDir:path.join(state,'devspace-state')},
      tools:{mode:'codex'},ui:{enabled:true},skills:{enabled:true,paths:[]},logging:{level:'info',format:'json',requests:true,toolCalls:true,shellCommands:false}
    };
    const config=path.join(configDir,'config.jsonc'),auth=path.join(configDir,'auth.json');
    const control=path.join(configRoot,'control-settings.json'),quick=path.join(state,'quick-tunnel-url.txt');
    writeFileSync(config,JSON.stringify(canonical));writeFileSync(auth,JSON.stringify({ownerToken:'fixture-owner'}));
    writeFileSync(control,JSON.stringify({schema_version:1,tunnel_mode:'Quick',remote_public_base_url:'https://dev.sanqi.org/server',public_base_path:'/server'}));
    writeFileSync(quick,'https://fixture-quick.trycloudflare.com\n');
    const script=fileURLToPath(new URL('../ops/prepare-effective-config.mjs',import.meta.url));
    const run=spawnSync(process.execPath,[script,'--config',config,'--auth',auth,'--control-settings',control,'--quick-url-file',quick,'--output-dir',effective],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.equal(path.resolve(run.stdout.trim()),path.resolve(effective));
    const generated=JSON.parse(readFileSync(path.join(effective,'config.jsonc'),'utf8'));
    assert.equal(generated.server.publicBaseUrl,'https://fixture-quick.trycloudflare.com/server');
    assert.ok(generated.server.allowedHosts.includes('fixture-quick.trycloudflare.com'));
    assert.equal(JSON.parse(readFileSync(config,'utf8')).server.publicBaseUrl,null,'canonical config stays mode-neutral in Quick mode');
    assert.equal(JSON.parse(readFileSync(path.join(effective,'auth.json'),'utf8')).ownerToken,'fixture-owner');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('legacy QuickConfig migration maps current Windows manager semantics without importing credentials',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'devspace-legacy-import-'));
  try{
    const project=path.join(root,'project');mkdirSync(project);
    const configDir=path.join(root,'config','devspace');mkdirSync(configDir,{recursive:true});
    const config=path.join(configDir,'config.jsonc');
    writeFileSync(config,JSON.stringify({configVersion:1,server:{host:'127.0.0.1',port:17677,publicBaseUrl:'https://dev.example/server'},workspaces:{allowedRoots:[root]},tools:{mode:'codex'},ui:{enabled:true},skills:{enabled:true,paths:[]},logging:{level:'info',format:'json',requests:true,toolCalls:true,shellCommands:false}}));
    const result=importLegacyQuickConfigCandidate({platformRoot:root,configPath:config,serviceUnit:'',tunnelUnit:''},{
      SchemaVersion:1,WorkspaceRoot:project,LocalPort:7777,TunnelMode:'Quick',FixedHostname:'old.example.com',ToolMode:'minimal',AutoStart:true,
      CredentialsFilePath:'C:\\never\\import\\secret.json'
    },'1.1.0-beta.4.local.13');
    assert.equal(result.ok,true);
    assert.deepEqual(result.settings.allowed_roots,[project]);
    assert.equal(result.settings.local_port,7777);
    assert.equal(result.settings.tunnel_mode,'Quick');
    assert.equal(result.settings.public_base_url,'https://old.example.com');
    assert.equal(result.settings.tool_mode,'claude');
    assert.equal(result.settings.auto_start,true);
    assert.equal(JSON.stringify(result).includes('never\\\\import\\\\secret'),false);
    assert.ok(result.notes.some(x=>x.includes('auth.json')));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('managed cloudflared builds Remote/Quick commands and extracts only trycloudflare origins',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'devspace-cloudflared-args-'));
  try{
    const token=path.join(root,'token.txt');writeFileSync(token,'fixture-token');
    assert.deepEqual(
      buildCloudflaredArgs({mode:'Quick',port:17677,protocol:'quic'}),
      ['tunnel','--protocol','quic','--no-autoupdate','--loglevel','info','--url','http://127.0.0.1:17677']
    );
    assert.deepEqual(
      buildCloudflaredArgs({mode:'Remote',port:17677,protocol:'auto',tokenFile:token}),
      ['tunnel','--no-autoupdate','--loglevel','info','run','--token-file',token]
    );
    assert.equal(quickTunnelOriginFromText('INF +https://fixture-name.trycloudflare.com/path ready'),'https://fixture-name.trycloudflare.com');
    assert.equal(quickTunnelOriginFromText('https://attacker.example.com/'), '');
    assert.throws(()=>buildCloudflaredArgs({mode:'Remote',port:17677,tokenFile:path.join(root,'missing')}),/token file is missing/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('Linux installers wire Quick/Remote helpers without exposing the Tunnel token in process arguments',()=>{
  const setup=readFileSync(new URL('../setup-linux.sh',import.meta.url),'utf8');
  const sidecar=readFileSync(new URL('../ops/install-linux-sidecar-instance.sh',import.meta.url),'utf8');
  const release=readFileSync(new URL('../package-release-linux.sh',import.meta.url),'utf8');
  for(const source of [setup,sidecar]){
    assert.match(source,/prepare-effective-config\.mjs/);
    assert.match(source,/managed-cloudflared\.mjs/);
    assert.match(source,/control-settings\.json/);
    assert.match(source,/quick-tunnel-url\.txt/);
  }
  assert.match(setup,/cloudflare-tunnel-token\.txt/);
  assert.doesNotMatch(setup,/run-cloudflared[\s\S]*--token\s+"\\\$CLOUDFLARED_TOKEN"/);
  assert.match(sidecar,/--token-file \$INSTANCE_TOKEN_FILE/);
  assert.match(release,/managed-cloudflared\.mjs/);
  assert.match(release,/prepare-effective-config\.mjs/);
});
test('project/Git parity records Review versions and rolls back selected code safely',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'devspace-project-versions-'));
  const repo=path.join(root,'repo');mkdirSync(repo);
  const git=(...args)=>{
    const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  try{
    git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    writeFileSync(path.join(repo,'code.txt'),'one\n');git('add','code.txt');git('commit','-m','baseline');
    const workspaces=[{id:'ws1',root:repo,last_used_at:1}];
    const project=projectChoices(workspaces)[0];assert.ok(project);
    assert.equal(projectDetails(workspaces,project.id).review.initialized,false);
    assert.equal(observeProject(workspaces,project.id,'baseline').version,'V0');
    writeFileSync(path.join(repo,'code.txt'),'two\n');
    assert.equal(observeProject(workspaces,project.id,'second').version,'V1');
    writeFileSync(path.join(repo,'code.txt'),'three\n');
    assert.equal(observeProject(workspaces,project.id,'third').version,'V2');
    const before=projectDetails(workspaces,project.id);
    assert.equal(before.review.versions.find(x=>x.version==='V1').workspace_id,'ws1');
    assert.equal(before.review.versions.find(x=>x.version==='V2').workspace_id,'ws1');
    const target=before.review.versions.find(x=>x.version==='V1');
    assert.equal(before.review.versions.find(x=>x.version==='V2').is_current,true);
    assert.equal(target.is_active,true);
    const result=rollbackReview(workspaces,project.id,target.review_ref);
    assert.equal(result.target,'V1');
    assert.equal(readFileSync(path.join(repo,'code.txt'),'utf8').replace(/\r\n/g,'\n'),'two\n');
    const after=projectDetails(workspaces,project.id);
    assert.equal(after.review.versions.find(x=>x.version==='V1').is_current,true);
    assert.equal(after.review.versions.find(x=>x.version==='V2').is_active,false);
    assert.equal(git('rev-parse','HEAD'),before.commits[0].commit,'real Git HEAD is not reset');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('UI includes semantic navigation, theme/language controls, responsive and accessible states',()=>{
  const html=readFileSync(new URL('../ops/runtime-console-ui.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../ops/runtime-console-ui.css',import.meta.url),'utf8');
  const js=readFileSync(new URL('../ops/runtime-console-ui.js',import.meta.url),'utf8');
  const destinations=['overview','services','connection','deployment','devspace','projects','history','diagnostics'];
  for(const id of destinations){
    assert.match(html,new RegExp('data-view="'+id+'"'));
    assert.match(html,new RegExp('id="view-'+id+'"'));
  }
  assert.equal((html.match(/class="nav-item(?: active)?"/g)||[]).length,8);
  assert.equal((html.match(/<section id="view-/g)||[]).length,8);
  for(const obsolete of ['runtime','connectivity','requests','activity'])assert.doesNotMatch(html,new RegExp('data-view="'+obsolete+'"'));
  for(const id of ['language','theme-toggle','confirm-dialog','request-filter'])assert.match(html+js,new RegExp(id));
  assert.match(html,/skip-link/);
  assert.match(css,/@media\(max-width:520px\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/:focus-visible/);
  assert.match(js,/pointerMismatch/);
  assert.match(js,/noManifest/);
  assert.match(js,/data-copy-owner/);
  assert.match(js,/rollback-confirm-input/);
  assert.match(js,/data-project-rollback/);
  assert.match(js,/data-save-devspace/);
  assert.match(js,/cfg-tunnel-mode/);
  assert.match(js,/data-import-legacy/);
  assert.match(js,/sourceConversation/);
  assert.match(js,/latestTool/);
});
