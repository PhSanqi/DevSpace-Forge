import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConsoleServer, parseOptions, resolveRunningPackage, runtimeInfo, snapshot } from '../ops/runtime-console.mjs';

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
    const unknown=await fetch(base+'/api/actions/not-real',{method:'POST',headers:{'x-devspace-console-token':token}});
    assert.equal(unknown.status,404);
    const ok=await fetch(base+'/api/actions/restart-devspace',{method:'POST',headers:{'x-devspace-console-token':token,origin:base}});
    assert.equal(ok.status,200);
    assert.deepEqual(calls,['devspace-control-server.service']);
  }finally{await new Promise((resolve)=>server.close(resolve));}
});
test('UI includes semantic navigation, theme/language controls, responsive and accessible states',()=>{
  const html=readFileSync(new URL('../ops/runtime-console-ui.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../ops/runtime-console-ui.css',import.meta.url),'utf8');
  const js=readFileSync(new URL('../ops/runtime-console-ui.js',import.meta.url),'utf8');
  for(const id of ['overview','runtime','connectivity','requests','activity','deployment'])assert.match(html,new RegExp('data-view="'+id+'"'));
  for(const id of ['language','theme-toggle','confirm-dialog','request-filter'])assert.match(html+js,new RegExp(id));
  assert.match(html,/skip-link/);
  assert.match(css,/@media\(max-width:520px\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/:focus-visible/);
  assert.match(js,/pointerMismatch/);
  assert.match(js,/noManifest/);
});
