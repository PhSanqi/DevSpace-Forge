import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConsoleServer, parseOptions, resolveRunningPackage, runtimeInfo, rollbackTargets, snapshot } from '../ops/runtime-console.mjs';
import { RUNTIME_SERVICE_RESTART_TIMEOUT_MS, restartUserService, switchRuntime } from '../ops/runtime-rollback.mjs';
import { runtimeRestartPreflight, withRuntimeRestartGuard } from '../ops/runtime-jobs-guard.mjs';
import { buildCloudflaredArgs, quickTunnelOriginFromText } from '../ops/managed-cloudflared.mjs';
import { gatewayRoute, resolveInstance, withGatewaySecurityHeaders } from '../ops/cloudflare-gateway-worker.mjs';
import {
  configHistoryItem, importLegacyQuickConfigCandidate, managementPublicBaseUrl,
  projectChoices, projectDetails, observeProject, restoreConfigHistory, rollbackReview, updateManagedConfig
} from '../ops/control-management.mjs';

const fixture=(prefix='devspace-console-')=>{
  const root=mkdtempSync(path.join(tmpdir(),prefix));
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
test('Cloudflare gateway preserves canonical hostname on HTTP upgrade and forces HTTPS origin fetch',()=>{
  assert.equal(resolveInstance('/server/healthz'),'server');
  assert.equal(resolveInstance('/group/mcp'),'group');
  const redirected=gatewayRoute('http://dev.sanqi.org/server/healthz?probe=1');
  assert.equal(redirected.kind,'redirect');
  assert.equal(redirected.url.href,'https://dev.sanqi.org/server/healthz?probe=1');
  const routed=gatewayRoute('https://dev.sanqi.org/server/healthz?probe=1');
  assert.equal(routed.kind,'origin');
  assert.equal(routed.url.href,'https://server-origin.sanqi.org/server/healthz?probe=1');
  const oauth=gatewayRoute('https://dev.sanqi.org/.well-known/oauth-protected-resource/server/mcp');
  assert.equal(oauth.kind,'origin');
  assert.equal(oauth.url.hostname,'server-origin.sanqi.org');
  assert.equal(gatewayRoute('https://dev.sanqi.org/unmanaged').kind,'not-found');
});
test('Cloudflare gateway adds HSTS to proxied group responses without changing streaming, status or OAuth headers',async()=>{
  const original=new Response('event: ready\n\n',{
    status:200,
    headers:{'content-type':'text/event-stream','cache-control':'no-cache','www-authenticate':'Bearer resource_metadata="https://dev.sanqi.org/.well-known/oauth-protected-resource/group/mcp"'}
  });
  const hardened=withGatewaySecurityHeaders(original);
  assert.equal(hardened.status,200);
  assert.equal(hardened.headers.get('strict-transport-security'),'max-age=3600');
  assert.equal(hardened.headers.get('content-type'),'text/event-stream');
  assert.equal(hardened.headers.get('cache-control'),'no-cache');
  assert.equal(hardened.headers.get('www-authenticate'),original.headers.get('www-authenticate'));
  assert.equal(await hardened.text(),'event: ready\n\n');
  const unauthorized=withGatewaySecurityHeaders(new Response(null,{status:401,headers:{'www-authenticate':'Bearer'}}));
  assert.equal(unauthorized.status,401);
  assert.equal(unauthorized.headers.get('www-authenticate'),'Bearer');
  assert.equal(unauthorized.headers.get('strict-transport-security'),'max-age=3600');
});
test('mobile Runtime version in overview metric wraps without clipping',()=>{
  const css=readFileSync(fileURLToPath(new URL('../ops/runtime-console-ui.css',import.meta.url)),'utf8');
  assert.match(css,/\.stats-grid \.stat-value\s*\{[^}]*overflow-wrap:anywhere/);
  assert.match(css,/\.stats-grid \.stat\s*\{[^}]*min-width:0/);
});
test('release provenance accepts clean source and refuses dirty candidate in strict mode',()=>{
  const temp=mkdtempSync(path.join(tmpdir(),'devspace-provenance-gate-'));
  const repo=path.join(temp,'repo');
  const server=path.join(repo,'server.js');
  const pkg=path.join(repo,'package.json');
  const out=path.join(temp,'control-provenance.json');
  mkdirSync(repo,{recursive:true});
  const git=(...args)=>spawnSync('git',['-C',repo,...args],{encoding:'utf8',timeout:5000,windowsHide:true});
  const run=(strict)=>spawnSync(process.execPath,[
    fileURLToPath(new URL('../ops/write-provenance.mjs',import.meta.url)),
    '--source-root',repo,'--server-file',server,'--package-file',pkg,'--output',out,
    '--version','test-only','--artifact-id','isolated-test',
    ...(strict?['--strict']:[]),
  ],{encoding:'utf8',timeout:8000,windowsHide:true});
  try{
    writeFileSync(server,'const candidate = 1;\n');
    writeFileSync(pkg,JSON.stringify({name:'isolated-test',version:'0.0.0'}));
    assert.equal(git('init','-q').status,0);
    assert.equal(git('add','.').status,0);
    assert.equal(git('-c','user.name=Candidate Test','-c','user.email=test@example.invalid',
      '-c','commit.gpgsign=false','commit','-q','-m','isolated fixture').status,0);
    assert.equal(run(true).status,0,'clean source must allow strict provenance');
    const clean=JSON.parse(readFileSync(out,'utf8'));
    assert.equal(clean.source_dirty,false);
    assert.equal(clean.server_sha256,createHash('sha256').update(readFileSync(server)).digest('hex'));
    writeFileSync(server,'const candidate = 2;\n');
    const denied=run(true);
    assert.notEqual(denied.status,0,'uncommitted candidate must not be a strict release');
    assert.match(denied.stderr,/Refusing dirty release provenance/);
    assert.equal(run(false).status,0,'an explicitly non-release audit may record dirty source');
    const audited=JSON.parse(readFileSync(out,'utf8'));
    assert.equal(audited.source_dirty,true);
    assert.equal(audited.git_commit,clean.git_commit);
    assert.equal(audited.server_sha256,createHash('sha256').update(readFileSync(server)).digest('hex'));
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('read-only job restart gate fails closed for active or unverifiable state',async()=>{
  const f=fixture();
  try{
    const state=path.join(f.root,'devspace-state');
    const jobs=path.join(state,'jobs');mkdirSync(jobs,{recursive:true});
    const dbFile=path.join(jobs,'jobs.sqlite');
    const {DatabaseSync}=await import('node:sqlite');
    let db=new DatabaseSync(dbFile);
    db.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_test_1','running');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_test_2','succeeded');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_pending','pending');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_cancelling','cancelling');
    db.close();
    const options={platformRoot:f.root,stateDir:state};
    const blocked=await runtimeRestartPreflight(options);
    assert.deepEqual(blocked,{ok:false,status:409,reason_code:'active_jobs',active_job_count:3,error:'Durable jobs are running; Runtime operation was not started.'});
    assert.equal(JSON.stringify(blocked).includes('job_test_1'),false);
    db=new DatabaseSync(dbFile);
    db.prepare("UPDATE durable_jobs SET status = 'succeeded' WHERE id = ?").run('job_test_1');
    db.prepare("UPDATE durable_jobs SET status = 'cancelled' WHERE id IN ('job_pending','job_cancelling')").run();
    db.close();
    assert.deepEqual(await runtimeRestartPreflight(options),{ok:true,active_job_count:0});
    writeFileSync(dbFile,'invalid SQLite');
    assert.equal((await runtimeRestartPreflight(options)).reason_code,'job_state_unavailable');
    assert.deepEqual(await runtimeRestartPreflight({platformRoot:path.join(f.root,'fresh')}),{ok:true,active_job_count:0});
    const damaged=path.join(f.root,'missing-db-state');
    mkdirSync(path.join(damaged,'jobs'),{recursive:true});
    assert.equal((await runtimeRestartPreflight({stateDir:damaged})).reason_code,'job_state_unavailable');
  }finally{f.clean();}
});
test('runtime switch gate holds across action and checks active jobs after acquisition',async()=>{
  const f=fixture();
  try{
    const state=path.join(f.root,'devspace-state');
    const jobs=path.join(state,'jobs');mkdirSync(jobs,{recursive:true});
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(path.join(jobs,'jobs.sqlite'));
    db.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    const options={platformRoot:f.root,stateDir:state};
    let release;
    let entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const pending=withRuntimeRestartGuard(options,async()=>{
      entered();
      await new Promise(resolve=>{release=resolve;});
      return {ok:true,status:200};
    });
    await started;
    const lock=path.join(state,'.runtime-switch-gate');
    assert.equal(existsSync(lock),true);
    const concurrent=await withRuntimeRestartGuard(options,async()=>({ok:true,status:200}));
    assert.equal(concurrent.reason_code,'runtime_switch_in_progress');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_late','running');
    release();
    assert.equal((await pending).ok,true);
    assert.equal(existsSync(lock),false);
    let called=false;
    const late=await withRuntimeRestartGuard(options,async()=>{called=true;return {ok:true};});
    assert.equal(late.reason_code,'active_jobs');
    assert.equal(called,false);
    assert.equal(existsSync(lock),false);
    db.close();
  }finally{f.clean();}
});
test('Windows uses the shared job gate without invoking Linux systemd',{skip:process.platform!=='win32'},async()=>{
  const f=fixture();
  try{
    const state=path.join(f.root,'state');
    let calls=0;
    const result=await withRuntimeRestartGuard({stateDir:state},async()=>{
      calls++;
      assert.equal(existsSync(path.join(state,'.runtime-switch-gate')),true);
      return {ok:true,status:200};
    });
    assert.deepEqual(result,{ok:true,status:200});
    assert.equal(calls,1);
    assert.equal(existsSync(path.join(state,'.runtime-switch-gate')),false);
  }finally{f.clean();}
});
test('Console refuses Runtime-affecting actions while durable jobs run, not Tunnel restart',async()=>{
  const f=fixture();
  const state=path.join(f.root,'devspace-state');
  mkdirSync(path.join(state,'jobs'),{recursive:true});
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path.join(state,'jobs','jobs.sqlite'));
  db.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
  db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_active','running');
  db.close();
  const calls=[];
  const opts={serve:0,platformRoot:f.root,stateDir:state,explicitRuntimePackage:f.declared,serviceUnit:'devspace-test.service',tunnelUnit:'tunnel-test.service',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}};
  const server=createConsoleServer(opts,{snapshot:async()=>({schema_version:2}),restart:unit=>{calls.push(unit);return {ok:true,status:200,unit};},switchRuntime:async()=>{calls.push('rollback');return {ok:true,status:200};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try{
    const token=(await (await fetch(url+'/api/action-token')).json()).token;
    const headers={origin:url,'x-devspace-console-token':token,'content-type':'application/json'};
    const post=(route,body={})=>fetch(url+route,{method:'POST',headers,body:JSON.stringify(body)});
    let response=await post('/api/actions/restart-devspace');
    assert.equal(response.status,409);
    assert.equal((await response.json()).reason_code,'active_jobs');
    response=await post('/api/management/service',{target:'devspace',action:'restart'});
    assert.equal(response.status,409);
    assert.equal((await response.json()).reason_code,'active_jobs');
    const target=rollbackTargets(opts,runtimeInfo(opts)).find(x=>!x.current);
    response=await post('/api/actions/rollback-runtime',{target_id:target.id,expected_sha256:target.server_sha256,observed_pid:123});
    assert.equal(response.status,409);
    assert.equal((await response.json()).reason_code,'active_jobs');
    assert.deepEqual(calls,[]);
    response=await post('/api/actions/restart-tunnel');
    assert.equal(response.status,200,'Tunnel is independently managed and not blocked by Runtime jobs');
    assert.deepEqual(calls,['tunnel-test.service']);
  }finally{await new Promise(resolve=>server.close(resolve));f.clean();}
});
test('systemd restart waits for graceful shutdown and classifies timeout without leaking stderr',()=>{
  let observed;
  restartUserService('devspace-test.service',(command,args,options)=>{
    observed={command,args,options};
    return {status:0};
  });
  assert.equal(observed.command,'systemctl');
  assert.deepEqual(observed.args,['--user','restart','devspace-test.service']);
  assert.equal(observed.options.timeout,RUNTIME_SERVICE_RESTART_TIMEOUT_MS);
  assert.ok(RUNTIME_SERVICE_RESTART_TIMEOUT_MS>=90_000);
  assert.throws(
    ()=>restartUserService('devspace-test.service',()=>({status:null,error:{code:'ETIMEDOUT'}})),
    /restart confirmation timed out/
  );
  assert.throws(
    ()=>restartUserService('devspace-test.service',()=>({status:1,stderr:'SECRET_MUST_NOT_APPEAR'})),
    error=>error.message.includes('did not succeed')&&!error.message.includes('SECRET_MUST_NOT_APPEAR')
  );
});
test('all packaged Control entry points include the runtime jobs guard dependency',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const read=file=>readFileSync(path.join(root,file),'utf8');
  for(const file of ['package-release-linux.sh','package-release-windows-payload.ps1','setup-linux.sh','ops/install-linux-sidecar-instance.sh']){
    assert.match(read(file),/runtime-jobs-guard\.mjs/,`${file} must deliver the imported guard module`);
  }
  for(const file of ['ops/runtime-console.mjs','ops/runtime-rollback.mjs','ops/control-management.mjs']){
    assert.match(read(file),/runtimeRestartPreflight|withRuntimeRestartGuard/,`${file} must protect runtime-affecting operations`);
  }
  for(const file of ['package-release-windows-payload.ps1','src/SetupInstaller.cs']){
    assert.match(read(file),/check-runtime-jobs\.mjs/,`${file} must deliver the native updater preflight`);
    assert.match(read(file),/runtime-jobs-guard\.mjs/,`${file} must deliver its imported guard`);
  }
});
test('native installer job preflight CLI fails closed on live or unreadable state',async()=>{
  const f=fixture();
  const state=path.join(f.root,'durable-state');
  const script=fileURLToPath(new URL('../ops/check-runtime-jobs.mjs',import.meta.url));
  const check=()=>spawnSync(process.execPath,[script,state],{encoding:'utf8',timeout:5000,windowsHide:true});
  try{
    assert.equal(check().status,0,'a fresh state directory is safe');
    const jobs=path.join(state,'jobs');mkdirSync(jobs,{recursive:true});
    const dbPath=path.join(jobs,'jobs.sqlite');
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(dbPath);
    db.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_running','running');
    db.close();
    let result=check();
    assert.equal(result.status,3,'active job must block a native update');
    assert.match(result.stderr,/active_jobs/);
    assert.doesNotMatch(result.stderr,/job_running/,'job identifiers must not leak into installer output');
    const resumed=new DatabaseSync(dbPath);
    resumed.prepare("UPDATE durable_jobs SET status = 'succeeded' WHERE id = ?").run('job_running');
    resumed.close();
    assert.equal(check().status,0,'completed job no longer blocks');
    writeFileSync(dbPath,'unreadable fixture');
    result=check();
    assert.equal(result.status,3,'corrupt job state must fail closed');
    assert.match(result.stderr,/job_state_unavailable/);
  }finally{f.clean();}
});
test('nested GitHub Actions runtime checkout does not dirty Control release provenance',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const result=spawnSync('git',['-C',root,'check-ignore','--quiet','runtime-src/package.json'],{encoding:'utf8'});
  assert.equal(result.status,0,`Nested runtime checkout must be ignored by the Control repository: ${result.stderr}`);
});
test('release scripts and workflow agree on Control, Runtime and Windows slot versions',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const read=(file)=>readFileSync(path.join(root,file),'utf8');
  const pkg=JSON.parse(read('package.json'));
  const dependency=pkg.dependencies['@waishnav/devspace'];
  const runtimeVersion=/^file:waishnav-devspace-(.+)\.tgz$/.exec(dependency)?.[1];
  assert.ok(runtimeVersion,`Unexpected packaged Runtime dependency: ${dependency}`);
  const suffix=/\.local\.(\d+)$/.exec(runtimeVersion)?.[1];
  assert.ok(suffix,`Unexpected canonical Runtime version: ${runtimeVersion}`);
  const slot=`windows-beta4-local${suffix}`;
  const workflow=read('.github/workflows/release.yml');
  const prepare=read('prepare-offline-windows-runtime.ps1');
  const packer=read('package-release-windows-payload.ps1');
  assert.equal(/^VERSION="\$\{1:-([^}]+)\}"/m.exec(read('package-release-linux.sh'))?.[1],pkg.version);
  assert.equal(/\$Version = '([^']+)'/.exec(read('package-release.ps1'))?.[1],pkg.version);
  assert.equal(/\$Version = '([^']+)'/.exec(packer)?.[1],pkg.version);
  assert.equal(/CANONICAL_RUNTIME_REF: (\S+)/.exec(workflow)?.[1],`runtime-${runtimeVersion}`);
  assert.equal(/CANONICAL_RUNTIME_VERSION: (\S+)/.exec(workflow)?.[1],runtimeVersion);
  assert.ok(prepare.includes(`$devSpaceVersion = '${runtimeVersion}'`));
  assert.ok(prepare.includes(`$devSpacePackageName = 'waishnav-devspace-${runtimeVersion}.tgz'`));
  assert.ok(prepare.includes(`$slotName = '${slot}'`));
  assert.ok(packer.includes(`runtime/slots/${slot}/READY`));
  assert.ok(workflow.includes(`DevSpaceControlRuntime-${slot}.tar`));
});
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
    assert.equal(info.runtime_topology,'direct-launcher');
    assert.equal(info.actual_runtime_id,'runtime-local13-candidate');
    assert.equal(info.configured_runtime_id,'runtime-local13');
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
    const consoleWrapper=path.join(bin,'run-runtime-console');
    const original='#!/bin/sh\nexec node '+path.join(f.actual,'dist','cli.js')+' serve\n';
    const consoleOriginal='#!/bin/sh\nexec node runtime-console.mjs --runtime-package "'+f.actual+'" --serve 17678\n';
    writeFileSync(wrapper,original,{mode:0o700});
    writeFileSync(consoleWrapper,consoleOriginal,{mode:0o700});
    const rt=runtimeInfo({platformRoot:f.root,explicitRuntimePackage:f.declared,serviceUnit:'',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}});
    const target=rollbackTargets({platformRoot:f.root},rt).find(x=>!x.current);
    const options={platformRoot:f.root,serviceUnit:'test-runtime.service',explicitRuntimePackage:f.actual};
    const params={options,live:rt.actual,target,expectedHash:target.server_sha256,observedPid:123,platform:'linux'};
    const {DatabaseSync}=await import('node:sqlite');
    options.stateDir=path.join(f.root,'active-jobs-state');
    mkdirSync(path.join(options.stateDir,'jobs'),{recursive:true});
    let jobsDb=new DatabaseSync(path.join(options.stateDir,'jobs','jobs.sqlite'));
    jobsDb.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    jobsDb.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_running','running');
    jobsDb.close();
    const inUse=await switchRuntime({...params,restart:()=>assert.fail('Runtime restart must not run while job is active'),probe:async()=>true});
    assert.equal(inUse.status,409);
    assert.equal(inUse.reason_code,'active_jobs');
    assert.equal(readFileSync(wrapper,'utf8'),original);
    assert.equal(readFileSync(consoleWrapper,'utf8'),consoleOriginal);
    jobsDb=new DatabaseSync(path.join(options.stateDir,'jobs','jobs.sqlite'));
    jobsDb.prepare("UPDATE durable_jobs SET status='succeeded' WHERE id='job_running'").run();
    jobsDb.close();
    assert.equal((await switchRuntime({...params,expectedHash:'0'.repeat(64)})).status,409);
    assert.equal(readFileSync(wrapper,'utf8'),original);
    assert.equal(readFileSync(consoleWrapper,'utf8'),consoleOriginal);
    let restarts=0;
    const failed=await switchRuntime({
      ...params,restart:()=>{restarts++;},
      probe:async(candidate)=>candidate.package_root===f.actual,
      probeAttempts:2,probeIntervalMs:1
    });
    assert.equal(failed.status,500);
    assert.equal(failed.restored,true);
    assert.equal(failed.reason_code,'target_not_healthy');
    assert.equal(restarts,2);
    assert.equal(readFileSync(wrapper,'utf8'),original);
    assert.equal(readFileSync(consoleWrapper,'utf8'),consoleOriginal);
    assert.equal(options.explicitRuntimePackage,f.actual);
    let timeoutRestarts=0;
    const timedOut=await switchRuntime({
      ...params,
      restart:()=>{if(++timeoutRestarts===1)throw new Error('The service restart confirmation timed out.');},
      probe:async()=>true,probeAttempts:1,probeIntervalMs:1
    });
    assert.equal(timedOut.status,500);
    assert.equal(timedOut.reason_code,'restart_timeout');
    assert.equal(timedOut.restored,true);
    assert.equal(timeoutRestarts,2);
    assert.equal(readFileSync(wrapper,'utf8'),original);
    assert.equal(readFileSync(consoleWrapper,'utf8'),consoleOriginal);
    assert.equal(options.explicitRuntimePackage,f.actual);
    const ok=await switchRuntime({...params,restart:()=>{},probe:async()=>true,probeAttempts:2,probeIntervalMs:1});
    assert.equal(ok.status,200);
    assert.match(readFileSync(wrapper,'utf8'),/runtime-local13[\\/]/);
    assert.match(readFileSync(consoleWrapper,'utf8'),/runtime-local13[\\/]/);
    assert.doesNotMatch(readFileSync(consoleWrapper,'utf8'),/runtime-local13-candidate[\\/]/);
    assert.equal(options.explicitRuntimePackage,target.package_root);
    assert.equal(readFileSync(path.join(f.root,'state','runtime-rollback',ok.backup_id+'.run-devspace.bak'),'utf8'),original);
    assert.equal(readFileSync(path.join(f.root,'state','runtime-rollback',ok.backup_id+'.run-runtime-console.bak'),'utf8'),consoleOriginal);
  }finally{f.clean();}
});
test('runtime switch supports quoted launchers under space paths and rejects ambiguous launchers',async()=>{
  const f=fixture('devspace console with spaces-');
  try{
    const bin=path.join(f.root,'bin');mkdirSync(bin,{recursive:true});
    const wrapper=path.join(bin,'run-devspace');
    const currentCli=path.join(f.actual,'dist','cli.js');
    const original='#!/bin/sh\nexec "node" "'+currentCli+'" serve\n';
    writeFileSync(wrapper,original,{mode:0o700});
    const rt=runtimeInfo({platformRoot:f.root,explicitRuntimePackage:f.actual,serviceUnit:'',processOverride:{pid:123,packageRoot:f.actual,evidence:'fixture'}});
    const target=rollbackTargets({platformRoot:f.root},rt).find(x=>!x.current);
    const params={options:{platformRoot:f.root,serviceUnit:'test-runtime.service',explicitRuntimePackage:f.actual},live:rt.actual,target,expectedHash:target.server_sha256,observedPid:123,platform:'linux',restart:()=>{},probe:async()=>true,probeAttempts:1,probeIntervalMs:1};
    const ok=await switchRuntime(params);
    assert.equal(ok.status,200);
    assert.match(readFileSync(wrapper,'utf8'),/runtime-local13[\\/]/);

    const ambiguous=original+'# duplicate '+currentCli+'\n';
    writeFileSync(wrapper,ambiguous,{mode:0o700});
    const rejected=await switchRuntime(params);
    assert.equal(rejected.status,409);
    assert.match(rejected.error,/launcher does not match/i);
    assert.equal(readFileSync(wrapper,'utf8'),ambiguous);
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
