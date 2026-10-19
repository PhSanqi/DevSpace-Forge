import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localRuntimeProbe, stageRuntimeSlot, validateRuntimeSlot, selectionPath, readRuntimeSelection, writeRuntimeSelection, slotPackage, switchRuntime, stopUserService } from '../ops/runtime-rollback.mjs';
import { runtimeInfo, rollbackTargets } from '../ops/runtime-console.mjs';

const shellArg=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'dsf-transaction-'));
  const source=path.join(root,'bundle','runtime');
  const pkg=path.join(source,'devspace','node_modules','@waishnav','devspace');
  mkdirSync(path.join(source,'node','bin'),{recursive:true});mkdirSync(path.join(pkg,'dist'),{recursive:true});
  writeFileSync(path.join(source,'node','bin','node'),'#!/bin/sh\nexec '+shellArg(process.execPath)+' "$@"\n',{mode:0o755});
  writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'1.2.3'}));
  writeFileSync(path.join(pkg,'dist','server.js'),'synthetic server');
  writeFileSync(path.join(pkg,'dist','cli.js'),"console.log('1.2.3');\n");
  const options={platformRoot:root,serviceUnit:'fixture.service',stateDir:path.join(root,'state','devspace-state')};
  const old=stageRuntimeSlot(options,source);
  writeFileSync(path.join(pkg,'dist','server.js'),'new synthetic server');
  const next=stageRuntimeSlot(options,source);
  mkdirSync(path.dirname(selectionPath(options)),{recursive:true});
  const previous={schema_version:1,slot:old.id,server_sha256:old.server_sha256,previous:null};
  writeFileSync(selectionPath(options),JSON.stringify(previous));
  mkdirSync(path.join(root,'bin'));
  const helper=fileURLToPath(new URL('../ops/runtime-rollback.mjs',import.meta.url));
  writeFileSync(path.join(root,'bin','run-devspace'),'#!/bin/bash\nexec '+shellArg(process.execPath)+' '+shellArg(helper)+' --resolve '+shellArg(root)+' ""\n');
  let live={pid:321,package_root:old.package_root};
  const calls=[];
  const params={options,target:next,expectedHash:next.server_sha256,observedPid:321,platform:'linux',probeAttempts:1,probeIntervalMs:0,
    readLive:()=>{assert.ok(existsSync(path.join(options.stateDir,'.runtime-switch-gate')));return live;},
    stop:()=>{calls.push('stop');live=null;},
    restart:()=>{calls.push('restart');live={pid:654,package_root:slotPackage(root,readRuntimeSelection(options).slot)};},
    probe:async target=>live?.package_root===target.package_root};
  return {root,source,pkg,options,old,next,previous,params,calls,clean:()=>rmSync(root,{recursive:true,force:true})};
}
const linux={skip:process.platform!=='linux'};

test('immutable staging preserves current and previous slots on copy failure',linux,()=>{
  const f=fixture();try{
    const selection=readFileSync(selectionPath(f.options),'utf8');let copies=0;
    assert.throws(()=>stageRuntimeSlot(f.options,f.source,{copy:(...args)=>{if(++copies===2)throw new Error('injected copy failure');cpSync(...args);}}),/injected copy failure/);
    assert.equal(readFileSync(selectionPath(f.options),'utf8'),selection);
    assert.equal(validateRuntimeSlot(f.options,f.old.id).server_sha256,f.old.server_sha256);
    assert.equal(validateRuntimeSlot(f.options,f.next.id).server_sha256,f.next.server_sha256);
    const incomplete=readdirSync(path.join(f.root,'runtime','slots')).filter(id=>![f.old.id,f.next.id].includes(id));
    assert.equal(incomplete.length,1);assert.equal(existsSync(path.join(f.root,'runtime','slots',incomplete[0],'READY')),false);
  }finally{f.clean();}
});
test('staging validation/launcher failure retains evidence without selecting it',linux,()=>{
  const f=fixture();try{
    assert.throws(()=>stageRuntimeSlot(f.options,f.source,{dryRun:()=>{throw new Error('injected validation failure');}}),/injected validation failure/);
    assert.deepEqual(readRuntimeSelection(f.options),f.previous);
    assert.equal(readdirSync(path.join(f.root,'runtime','slots')).length,3);
  }finally{f.clean();}
});
test('same-version reinstall always creates a distinct slot and preserves rollback bytes',linux,()=>{
  const f=fixture();try{
    const again=stageRuntimeSlot(f.options,f.source);
    assert.notEqual(again.id,f.next.id);assert.equal(again.server_sha256,f.next.server_sha256);
    assert.equal(validateRuntimeSlot(f.options,f.old.id).server_sha256,f.old.server_sha256);
  }finally{f.clean();}
});
test('selection/status/inventory survive a new Console instance and list real packaged slots',linux,async()=>{
  const f=fixture();try{
    const result=await switchRuntime(f.params);assert.equal(result.ok,true);
    assert.deepEqual(f.calls,['stop','restart']);
    const selected=readRuntimeSelection(f.options);
    assert.deepEqual(selected.previous,{slot:f.old.id,server_sha256:f.old.server_sha256});
    const options={...f.options,explicitRuntimePackage:f.old.package_root,processOverride:{pid:654,packageRoot:f.next.package_root}};
    const status=runtimeInfo(options);
    assert.equal(status.configured.package_root,f.next.package_root);assert.equal(status.pointer_mismatch,false);
    assert.equal(status.active_slot,f.next.id);assert.equal(status.previous_slot,f.old.id);
    assert.deepEqual(rollbackTargets(options).map(x=>x.id).sort(),[f.old.id,f.next.id].sort());
    assert.equal(existsSync(path.join(f.options.stateDir,'.runtime-switch-gate')),false);
  }finally{f.clean();}
});
for(const boundary of ['stop','start','identity'])test('switch recovers previous selection/Runtime after '+boundary+' failure',linux,async()=>{
  const f=fixture();try{
    let first=true;
    const hooks=boundary==='stop'?{stop:(...args)=>{if(first){first=false;throw new Error('injected stop failure');}f.params.stop(...args);}}:
      boundary==='start'?{restart:(...args)=>{if(first){first=false;throw new Error('injected start failure');}f.params.restart(...args);}}:
      {probe:async target=>target.id===f.old.id};
    const result=await switchRuntime({...f.params,...hooks});
    assert.equal(result.ok,false);assert.equal(result.restored,true);
    assert.deepEqual(readRuntimeSelection(f.options),f.previous);
    const evidence=JSON.parse(readFileSync(path.join(f.options.stateDir,'runtime-rollback',result.backup_id+'.json')));
    assert.equal(evidence.phase,'restored');assert.ok(evidence.error);
    assert.equal(validateRuntimeSlot(f.options,f.old.id).server_sha256,f.old.server_sha256);
  }finally{f.clean();}
});
test('failed recovery surfaces both errors and preserves the previous complete slot and evidence',linux,async()=>{
  const f=fixture();try{
    const result=await switchRuntime({...f.params,restart:()=>{throw new Error('injected start failure');}});
    assert.equal(result.restored,false);assert.match(result.error,/start failure/);assert.match(result.recovery_error,/start failure/);
    assert.deepEqual(readRuntimeSelection(f.options),f.previous);
    assert.equal(JSON.parse(readFileSync(path.join(f.options.stateDir,'runtime-rollback',result.backup_id+'.json'))).phase,'recovery_failed');
    assert.equal(validateRuntimeSlot(f.options,f.old.id).server_sha256,f.old.server_sha256);
  }finally{f.clean();}
});
test('gate-held revalidation rejects a stale PID, modified hash, launcher or job state before stopping',linux,async()=>{
  for(const boundary of ['pid','hash','fileset','launcher','jobs']){
    const f=fixture();try{
      if(boundary==='hash')writeFileSync(path.join(f.next.package_root,'dist','server.js'),'tampered');
      if(boundary==='fileset')writeFileSync(path.join(f.root,'runtime','slots',f.next.id,'__proto__'),'unexpected file');
      if(boundary==='launcher')writeFileSync(path.join(f.root,'bin','run-devspace'),'#!/bin/sh\n# runtime-rollback.mjs --resolve\nexit 7\n');
      if(boundary==='jobs')mkdirSync(path.join(f.options.stateDir,'jobs')); // Missing database must fail closed.
      const result=await switchRuntime({...f.params,...(boundary==='pid'?{observedPid:999}:{})});
      assert.equal(result.ok,false,boundary);assert.equal(result.status,409,boundary);
      assert.equal(f.calls.length,0,boundary);assert.deepEqual(readRuntimeSelection(f.options),f.previous);
    }finally{f.clean();}
  }
});
test('stop confirms both systemd MainPID=0 and disappearance of the original process',linux,()=>{
  assert.throws(()=>stopUserService('fixture.service',null,()=>({status:1})),/unconfirmed/);
  assert.throws(()=>stopUserService('fixture.service',null,(_cmd,args)=>({status:0,stdout:args.includes('show')?'987\n':''})),/could not be confirmed/);
  assert.throws(()=>stopUserService('fixture.service',{pid:process.pid},()=>({status:0,stdout:'0\n'})),/still exists/);
  stopUserService('fixture.service',null,()=>({status:0,stdout:'0\n'}));
});
test('offline selection refuses a live Runtime',linux,async()=>{
  const f=fixture();try{
    const result=await switchRuntime({...f.params,offline:true});assert.equal(result.status,409);assert.match(result.error,/offline/);
    assert.deepEqual(readRuntimeSelection(f.options),f.previous);
  }finally{f.clean();}
});
test('a gate left by a dead owner is reclaimed before a switch',linux,async()=>{
  const f=fixture();try{
    const gate=path.join(f.options.stateDir,'.runtime-switch-gate');mkdirSync(gate,{recursive:true});
    writeFileSync(path.join(gate,'owner.json'),JSON.stringify({pid:2147483647,processStartIdentity:'linux:1',createdAt:Date.now(),nonce:'dead'}));
    assert.equal((await switchRuntime(f.params)).ok,true);
    assert.equal(existsSync(gate),false);
  }finally{f.clean();}
});
test('a live gate owner still blocks a switch',linux,async()=>{
  const f=fixture();try{
    const gate=path.join(f.options.stateDir,'.runtime-switch-gate');mkdirSync(gate,{recursive:true});
    writeFileSync(path.join(gate,'owner.json'),JSON.stringify({pid:process.pid,processStartIdentity:null,createdAt:Date.now(),nonce:'live'}));
    const result=await switchRuntime(f.params);
    assert.equal(result.reason_code,'runtime_switch_in_progress');
    assert.equal(existsSync(gate),true);assert.equal(f.calls.length,0);
  }finally{f.clean();}
});
test('guard-held switch re-reads durable jobs before stopping',linux,async()=>{
  const f=fixture();try{
    mkdirSync(path.join(f.options.stateDir,'jobs'),{recursive:true});
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(path.join(f.options.stateDir,'jobs','jobs.sqlite'));
    db.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job_running','running');db.close();
    const result=await switchRuntime({...f.params,guardHeld:true});
    assert.equal(result.status,409);assert.equal(result.reason_code,'active_jobs');
    assert.equal(f.calls.length,0);assert.deepEqual(readRuntimeSelection(f.options),f.previous);
  }finally{f.clean();}
});
test('validateRuntimeSlot accepts a symlinked install root but rejects a symlinked slot',linux,()=>{
  const f=fixture();try{
    const linked=path.join(f.root,'linked-install');symlinkSync(f.root,linked,'dir');
    assert.equal(validateRuntimeSlot({...f.options,platformRoot:linked},f.old.id).id,f.old.id);
    const slots=path.join(f.root,'runtime','slots');
    rmSync(path.join(slots,f.next.id),{recursive:true,force:true});
    symlinkSync(path.join(slots,f.old.id),path.join(slots,f.next.id),'dir');
    assert.throws(()=>validateRuntimeSlot(f.options,f.next.id),/real directory/);
  }finally{f.clean();}
});
test('localRuntimeProbe parses JSONC config and surfaces parse failures as errors',linux,async(t)=>{
  const f=fixture(),repo=fileURLToPath(new URL('..',import.meta.url));
  const parser=path.join(repo,'runtime-src','node_modules','jsonc-parser');
  if(!existsSync(parser)){f.clean();t.skip('runtime-src dependencies are not installed');return;}
  cpSync(parser,path.join(path.dirname(path.dirname(f.old.package_root)),'jsonc-parser'),{recursive:true});
  const server=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=server.address().port,config=path.join(f.root,'probe.jsonc');
    writeFileSync(config,'// JSONC comments and trailing commas\n{\n "server": {"port": '+port+', "publicBaseUrl": "http://localhost"},\n "storage": {"stateDir": '+JSON.stringify(f.options.stateDir)+'},\n}\n');
    const target={package_root:f.old.package_root};
    const probeOptions={...f.options,configPath:config,serviceUnit:'probe.service'};
    const readLive=()=>({pid:process.pid,package_root:f.old.package_root});
    assert.equal(await localRuntimeProbe(probeOptions,target,{readLive}),true);
    writeFileSync(config,'{ // broken\n "server": {"port": ');
    await assert.rejects(localRuntimeProbe(probeOptions,target,{readLive}),/Unable to parse|JSONC/);
  }finally{await new Promise(resolve=>server.close(resolve));f.clean();}
});
test('fresh-install guard failure removes the pending selection, mirror and launcher',linux,()=>{
  const f=fixture();try{
    rmSync(selectionPath(f.options),{force:true});
    const config=path.join(f.root,'config.jsonc');writeFileSync(config,JSON.stringify({storage:{stateDir:f.options.stateDir}}));
    const bin=path.join(f.root,'fake-bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\ncase " $* " in *" show "*) echo 0;; esac\nexit 0\n',{mode:0o755});
    const script=path.join(f.root,'fresh-fail.sh');
    const next={schema_version:1,slot:f.next.id,server_sha256:f.next.server_sha256,previous:null};
    const candidate=path.join(f.root,'candidate.json');writeFileSync(candidate,JSON.stringify(next));
    const launcher=path.join(f.root,'bin','run-devspace'),mirror=path.join(f.root,'runtime','active-slot.txt');
    rmSync(launcher,{force:true});
    writeFileSync(script,'#!/bin/sh\ncp "$1" "$2"\nprintf "new launcher\\n" > "$3"\nprintf "slot\\n" > "$4"\nexit 9\n');
    const helper=fileURLToPath(new URL('../ops/runtime-rollback.mjs',import.meta.url));
    const result=spawnSync(process.execPath,[helper,'--install-guard',f.root,config,'fixture.service',script,candidate,selectionPath(f.options),launcher,mirror],{
      encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}
    });
    assert.equal(result.status,1);assert.match(result.stderr,/Installer failed/);
    assert.equal(existsSync(selectionPath(f.options)),false);assert.equal(existsSync(mirror),false);assert.equal(existsSync(launcher),false);
    const rollback=path.join(f.options.stateDir,'runtime-rollback');
    const evidence=readdirSync(rollback).find(x=>x.startsWith('install-'));
    for(const name of ['failed-selection.json','failed-active-slot.txt','failed-run-devspace'])
      assert.ok(existsSync(path.join(rollback,evidence,name)),name);
  }finally{f.clean();}
});
test('installer crash/failed child releases only its own gate and preserves selection',linux,()=>{
  const f=fixture();try{
    const script=path.join(f.root,'failed-installer.sh');
    writeFileSync(script,'#!/bin/sh\nexit 17\n');
    const bin=path.join(f.root,'fake-bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\necho 0\n',{mode:0o755});
    const helper=fileURLToPath(new URL('../ops/runtime-rollback.mjs',import.meta.url));
    const config=path.join(f.root,'config.jsonc');writeFileSync(config,JSON.stringify({storage:{stateDir:f.options.stateDir}}));
    const result=spawnSync(process.execPath,[helper,'--install-guard',f.root,config,'fixture.service',script],{encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}});
    assert.equal(result.status,1);assert.match(result.stderr,/Installer failed/);
    assert.equal(existsSync(path.join(f.options.stateDir,'.runtime-switch-gate')),false);
    assert.deepEqual(readRuntimeSelection(f.options),f.previous);
  }finally{f.clean();}
});
test('Windows source stages a new slot, confirms stops and retains product/cloudflared backups on failure',()=>{
  const source=readFileSync(new URL('../src/SetupInstaller.cs',import.meta.url),'utf8');
  const stop=source.slice(source.indexOf('internal static List<string> StopManagedRuntimeProcesses'),source.indexOf('private static string ExecutableFromCommand'));
  assert.match(stop,/StartTime\.ToUniversalTime/);assert.match(stop,/!process\.WaitForExit\(5000\) \|\| !process\.HasExited/);
  assert.match(stop,/stop is unconfirmed/);
  assert.match(stop,/ownership not proven/, 'unreadable same-named processes are skipped instead of aborting');
  assert.match(stop,/if \(!owned\)/);
  assert.match(source,/ExtractOfflinePayload\(sourceRoot, stage\)/);assert.match(source,/Directory\.Move\(stagedSlot, destination\)/);
  assert.match(source,/Staged Runtime launcher dry-run failed/);assert.match(source,/Staged Runtime provenance hash mismatch/);
  assert.match(source,/File\.Replace\(temporary, file, null\)/);
  assert.match(source,/afterPayload\(\)/);assert.match(source,/BackupUpdateFiles\(sourceRoot, targetRoot, backup\)/);
  assert.match(source,/if \(stopped && productsChanged\)/);
  assert.match(source,/\(stopped \|\| productsChanged\) && consolePort > 0 && previous != null/);
  assert.match(source,/processStartIdentity/);assert.match(source,/ReclaimDeadRuntimeUpdateGate/);
  assert.match(source,/gate \+ "\.tmp-"/);
  assert.match(source,/if \(entry\.Key == @"runtime\\active-slot\.txt"\) continue/);
  assert.match(source,/catch \(Exception recovery\) \{ failures\.Add\(recovery\); \}/);
  assert.match(source,/throw new AggregateException/);assert.doesNotMatch(source,/Delete\(cloudflaredBackup\)/);
  assert.doesNotMatch(source,/Directory\.Delete\(runtime, true\)/);
});
test('root legacy activation/rollback/OOB scripts are absent and not packaged or documented',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const packaging=readFileSync(path.join(root,'package-release-windows-payload.ps1'),'utf8');
  const docs=['README.md','README.zh-CN.md',...readdirSync(path.join(root,'docs')).filter(x=>x.endsWith('.md')).map(x=>'docs/'+x)].map(file=>readFileSync(path.join(root,file),'utf8')).join('\n');
  for(const script of ['switch-runtime-slot-live.ps1','activate-runtime-slot.ps1','rollback-runtime-slot.ps1','update-control-platform-out-of-band.ps1']){
    assert.equal(existsSync(path.join(root,script)),false);assert.equal(packaging.includes(script),false);assert.equal(docs.includes(script),false);
  }
});

function installerFixture() {
  const f=fixture(),bundle=path.join(f.root,'release'),repo=fileURLToPath(new URL('..',import.meta.url));
  mkdirSync(bundle);cpSync(path.join(repo,'setup-linux.sh'),path.join(bundle,'setup-linux.sh'));
  cpSync(f.source,path.join(bundle,'runtime'),{recursive:true,verbatimSymlinks:true});
  mkdirSync(path.join(bundle,'ops','control-ui'),{recursive:true});
  for(const name of ['runtime-console.sh','runtime-console.mjs','runtime-rollback.mjs','runtime-jobs-guard.mjs','control-management.mjs','control-service-controller.mjs','windows-process-job.mjs','managed-cloudflared.mjs','prepare-effective-config.mjs','runtime-console-ui.html','runtime-console-ui.css','runtime-console-ui.js'])cpSync(path.join(repo,'ops',name),path.join(bundle,'ops',name));
  writeFileSync(path.join(bundle,'ops','control-ui','index.html'),'<html>fixture</html>');
  writeFileSync(path.join(bundle,'cloudflared'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const fakeBin=path.join(f.root,'fake-bin');mkdirSync(fakeBin);
  const log=path.join(f.root,'systemctl.log');
  writeFileSync(path.join(fakeBin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$DSF_FAKE_SYSTEMCTL_LOG"\ncase " $* " in *" show "*) echo 0;; *" restart "*) exit 23;; esac\n',{mode:0o755});
  const installed=path.join(f.root,'installed'),configRoot=path.join(f.root,'config-home');
  const run=(start=false)=>spawnSync('bash',[path.join(bundle,'setup-linux.sh'),'--non-interactive','--reuse-existing-tunnel',...(start?[]:['--no-start'])],{
    encoding:'utf8',timeout:30000,env:{...process.env,HOME:f.root,XDG_CONFIG_HOME:configRoot,DEVSPACE_CONTROL_HOME:installed,PATH:fakeBin+path.delimiter+process.env.PATH,DSF_FAKE_SYSTEMCTL_LOG:log}
  });
  return {...f,bundle,installed,configRoot,run,log};
}
test('offline installer and same-version upgrade use new slots and a launcher reading persisted selection',linux,()=>{
  const f=installerFixture();try{
    const first=f.run();assert.equal(first.status,0,first.stderr);
    const options={platformRoot:f.installed,configPath:path.join(f.configRoot,'devspace-control','devspace','config.jsonc')};
    const old=readRuntimeSelection(options);assert.ok(old.slot);
    const again=f.run();assert.equal(again.status,0,again.stderr);
    const next=readRuntimeSelection(options);assert.notEqual(next.slot,old.slot);assert.equal(next.previous.slot,old.slot);
    assert.equal(validateRuntimeSlot(options,old.slot).server_sha256,old.server_sha256);
    const launcher=readFileSync(path.join(f.installed,'bin','run-devspace'),'utf8');assert.match(launcher,/--resolve/);
    assert.doesNotMatch(launcher,/exec .*devspace\/dist\/cli\.js/);
    assert.equal(existsSync(path.join(f.installed,'runtime','node')),false);
  }finally{f.clean();}
});
test('installer upgrade start failure restores old selection and retains its immutable slot',linux,()=>{
  const f=installerFixture();try{
    assert.equal(f.run().status,0);
    const options={platformRoot:f.installed,configPath:path.join(f.configRoot,'devspace-control','devspace','config.jsonc')};
    const before=readRuntimeSelection(options);
    const failed=f.run(true);assert.notEqual(failed.status,0);assert.match(failed.stderr,/restart command did not succeed/);
    assert.deepEqual(readRuntimeSelection(options),before);
    assert.equal(validateRuntimeSlot(options,before.slot).server_sha256,before.server_sha256);
    const commands=readFileSync(f.log,'utf8');assert.match(commands,/--user restart devspace-control\.service/);
    assert.doesNotMatch(commands,/--user enable --now devspace-control\.service/);
    assert.equal(existsSync(path.join(path.dirname(selectionPath(options)),'.runtime-switch-gate')),false);
  }finally{f.clean();}
});

test('installer child killed after selection write restores selection and launcher from preserved evidence',linux,()=>{
  const f=fixture();try{
    const config=path.join(f.root,'config.jsonc');writeFileSync(config,JSON.stringify({storage:{stateDir:f.options.stateDir}}));
    const bin=path.join(f.root,'fake-bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\necho 0\n',{mode:0o755});
    const script=path.join(f.root,'crash-installer.sh');
    const next={schema_version:1,slot:f.next.id,server_sha256:f.next.server_sha256,previous:{slot:f.old.id,server_sha256:f.old.server_sha256}};
    const candidate=path.join(f.root,'candidate.json');writeFileSync(candidate,JSON.stringify(next));
    const launcher=path.join(f.root,'bin','run-devspace'),beforeLauncher=readFileSync(launcher,'utf8');
    writeFileSync(script,'#!/bin/sh\ncp "$1" "$2"\nprintf "broken launcher\\n" > "$3"\nkill -KILL $$\n');
    const helper=fileURLToPath(new URL('../ops/runtime-rollback.mjs',import.meta.url));
    const result=spawnSync(process.execPath,[helper,'--install-guard',f.root,config,'fixture.service',script,candidate,selectionPath(f.options),launcher],{
      encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}
    });
    assert.equal(result.status,1);assert.match(result.stderr,/terminated by SIGKILL/);
    assert.deepEqual(readRuntimeSelection(f.options),f.previous);assert.equal(readFileSync(launcher,'utf8'),beforeLauncher);
    const rollback=path.join(f.options.stateDir,'runtime-rollback');
    const evidence=readdirSync(rollback).find(x=>x.startsWith('install-'));
    assert.ok(existsSync(path.join(rollback,evidence,'before.json')));assert.ok(existsSync(path.join(rollback,evidence,'run-devspace.bak')));
    assert.equal(JSON.parse(readFileSync(path.join(rollback,evidence,'failure.json'))).recovery_error,null);
    assert.equal(existsSync(path.join(f.options.stateDir,'.runtime-switch-gate')),false);
  }finally{f.clean();}
});

test('Console follows a custom configured state directory and rejects disagreement before any switch',linux,async()=>{
  const f=fixture();try{
    const config=path.join(f.root,'custom.jsonc');writeFileSync(config,JSON.stringify({storage:{stateDir:f.options.stateDir}}));
    const options={platformRoot:f.root,configPath:config,processOverride:{pid:321,packageRoot:f.old.package_root}};
    assert.equal(runtimeInfo(options).active_slot,f.old.id);
    await assert.rejects(switchRuntime({...f.params,options:{...options,stateDir:path.join(f.root,'wrong')}}),/disagree/);
    assert.equal(f.calls.length,0);assert.deepEqual(readRuntimeSelection(f.options),f.previous);
  }finally{f.clean();}
});

test('fresh installer distinguishes an absent inactive unit from an unavailable user systemd manager',linux,()=>{
  const f=installerFixture();try{
    const systemctl=path.join(f.root,'fake-bin','systemctl');
    writeFileSync(systemctl,'#!/bin/sh\ncase " $* " in *" MainPID "*) exit 1;; *" LoadState "*) printf "LoadState=not-found\\nActiveState=inactive\\n";exit 1;; esac\n',{mode:0o755});
    assert.equal(f.run().status,0);
    writeFileSync(systemctl,'#!/bin/sh\nexit 1\n',{mode:0o755});
    const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/process identity is unavailable/);
  }finally{f.clean();}
});

test('JSON publication precedes the legacy mirror and mirror failure is surfaced',linux,()=>{
  const f=fixture();try{
    const mirror=path.join(f.root,'runtime','active-slot.txt');mkdirSync(mirror);
    const next={schema_version:1,slot:f.next.id,server_sha256:f.next.server_sha256,previous:{slot:f.old.id,server_sha256:f.old.server_sha256}};
    assert.throws(()=>writeRuntimeSelection(f.options,next));
    assert.deepEqual(readRuntimeSelection(f.options),next,'JSON remains authoritative after mirror publication fails');
    assert.ok(existsSync(path.join(f.root,'runtime','slots',f.old.id)));
  }finally{f.clean();}
});
test('read-only shell Console uses JSON over a stale mirror and fails closed on invalid JSON',linux,()=>{
  const f=fixture();try{
    const config=path.join(f.root,'config.jsonc');
    writeFileSync(config,'// JSONC fixture\n'+JSON.stringify({storage:{stateDir:f.options.stateDir}}));
    writeFileSync(path.join(f.root,'runtime','active-slot.txt'),'../../stale\n');
    const bin=path.join(f.root,'fake-bin');mkdirSync(bin);
    for(const name of ['systemctl','journalctl'])writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
    const script=fileURLToPath(new URL('../ops/runtime-console.sh',import.meta.url));
    const run=()=>spawnSync('bash',[script,'--root',f.root,'--config',config],{encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}});
    const result=run();assert.equal(result.status,0,result.stderr);
    assert.ok(result.stdout.includes('active-slot: '+f.old.id));assert.ok(result.stdout.includes('package-root: '+f.old.package_root));
    writeFileSync(selectionPath(f.options),'{broken');
    assert.notEqual(run().status,0);
  }finally{f.clean();}
});
test('Windows native and PowerShell readers prefer JSON and updater accepts/restarts the managed owner under gate',()=>{
  const resolver=readFileSync(new URL('../src/RuntimeResolver.cs',import.meta.url),'utf8');
  const ps=readFileSync(new URL('../ops/start-runtime-console.ps1',import.meta.url),'utf8');
  const setup=readFileSync(new URL('../src/SetupInstaller.cs',import.meta.url),'utf8');
  assert.match(resolver,/var selection = ReadSelection\(platformRoot\)/);assert.match(resolver,/yield break/);
  assert.match(resolver,/Selected Runtime hash mismatch; legacy mirror was not used/);
  assert.ok(ps.indexOf('$selectionFile')<ps.indexOf("'runtime\\active-slot.txt'"));
  assert.match(ps,/Get-FileHash -LiteralPath \$server/);
  const write=setup.slice(setup.indexOf('private static void WriteRuntimeSelection'),setup.indexOf('private static void StartAndAcceptRuntime'));
  assert.ok(write.indexOf('RuntimeResolver.SelectionPath')<write.indexOf('"active-slot.txt"'));
  assert.match(setup,/if \(consolePort > 0\) StartAndAcceptRuntime\(targetRoot, consolePort, evidence\)/);
  assert.match(setup,/if \(\(stopped \|\| productsChanged\) && consolePort > 0 && previous != null\)/);
  assert.match(setup,/New Runtime process slot\/hash\/version identity mismatch/);
  assert.match(setup,/process\.StartTime\.ToUniversalTime\(\) < started\.AddSeconds\(-1\)/);
  assert.match(setup,/Process\.GetProcessById/);assert.match(setup,/process\.MainModule\.FileName/);
  assert.match(setup,/health.ContainsKey\("ok"\) && Convert.ToBoolean\(health\["ok"\]\)/);
});

test('native update fixtures use real launch binaries and cover JSON migration, validation and process recovery',()=>{
  const source=readFileSync(new URL('../tests/DevSpaceConfigurationTests.cs',import.meta.url),'utf8');
  assert.match(source,/File.Copy\(FindNode\(\), Path.Combine\(slot, "node", "node.exe"\), true\)/);
  assert.match(source,/PackRuntimeFixture\(source, Path.Combine\(install, "payload", "runtime.tar"\)\)/);
  assert.match(source,/WriteRuntimeFixture\(install, "old-slot"/);
  assert.match(source,/same-version reinstall gets another slot/);assert.match(source,/old process is accepted before gate release/);
  assert.match(source,/JSON ignores invalid mirror/);assert.match(source,/failed restore retains cloudflared backup/);
  assert.match(source,/validation failure does not select or stop the live Runtime/);
  assert.doesNotMatch(source.slice(source.indexOf('private static void TestSetupOfflinePayload'),source.indexOf('private static void TestSetupExistingConfiguration')),/new byte\[\]/);
});
