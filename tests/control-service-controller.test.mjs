import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServiceController } from '../ops/control-service-controller.mjs';
import { managementSnapshot, serviceAction, setAutostart } from '../ops/control-management.mjs';

function fixture(){
  const root=mkdtempSync(path.join(tmpdir(),'control-lifecycle-'));
  const runtime=path.join(root,'runtime','slots','slot-a');
  const configDir=path.join(root,'state','devspace-config');
  const configPath=path.join(configDir,'config.jsonc');
  const tokenFile=path.join(root,'state','secrets','cloudflare-tunnel-token.txt');
  for(const file of [path.join(runtime,'node','node.exe'),path.join(runtime,'devspace','node_modules','@waishnav','devspace','dist','cli.js'),path.join(root,'cloudflared.exe'),tokenFile,configPath]){
    mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,file===tokenFile?'synthetic-token-value':file===configPath?JSON.stringify({configVersion:1,server:{port:17677}}):'');
  }
  writeFileSync(path.join(root,'runtime','active-slot.txt'),'slot-a\n');
  return {root,configPath,tokenFile,clean:()=>rmSync(root,{recursive:true,force:true})};
}

test('Linux controller delegates status, action, autostart and logs to user systemd',async()=>{
  const calls=[];
  const runCommand=(command,args)=>{
    calls.push([command,...args]);
    return {ok:true,status:0,stdout:args.includes('MainPID')?'4321':args.includes('is-enabled')?'enabled':args.includes('is-active')?'active':'journal line',stderr:''};
  };
  const controller=createServiceController({serviceUnit:'devspace-test.service',tunnelUnit:'tunnel-test.service'},{platform:'linux',runCommand});
  assert.deepEqual(controller.state('devspace'),{status:'active',enabled:'enabled',pid:4321});
  assert.equal((await controller.action('tunnel','restart')).ok,true);
  assert.deepEqual(controller.autostart(true),{ok:true,enabled:true});
  assert.equal(controller.log('devspace'), 'journal line');
  assert.ok(calls.some(x=>x.join(' ')==='systemctl --user restart tunnel-test.service'));
  assert.ok(calls.some(x=>x.join(' ')==='systemctl --user enable devspace-test.service'));
  assert.ok(calls.some(x=>x[0]==='journalctl'&&x.includes('devspace-test.service')));
});

test('Windows controller assigns direct DevSpace and cloudflared children and closes Job after confirmed shutdown',async()=>{
  const f=fixture();
  let nextPid=7000;
  const spawned=[],commands=[],jobEvents=[];
  const createProcessJob=()=>({addPid:pid=>jobEvents.push(['add',pid]),close:()=>jobEvents.push(['close'])});
  const spawnProcess=(command,args,options)=>{
    const child=new EventEmitter();
    child.pid=++nextPid;child.exitCode=null;child.signalCode=null;child.killed=false;
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    spawned.push({command,args,options,child});
    return child;
  };
  const runCommand=(command,args)=>{
    commands.push([command,...args]);
    if(args[0]?.endsWith('prepare-effective-config.mjs'))
      return {ok:true,status:0,stdout:path.join(f.root,'state','effective-config')+'\n',stderr:''};
    if(command==='taskkill'){
      const found=spawned.find(x=>x.child.pid===Number(args[1]));
      queueMicrotask(()=>{found.child.exitCode=0;found.child.emit('exit',0,null);});
    }
    return {ok:true,status:0,stdout:'',stderr:''};
  };
  try{
    mkdirSync(path.join(f.root,'runtime','slots','slot-a','serena','bin'),{recursive:true});
    mkdirSync(path.join(f.root,'runtime','slots','slot-a','uv'),{recursive:true});
    writeFileSync(path.join(f.root,'settings.json'),JSON.stringify({CloudflaredProtocol:'http2'}));
    process.env.DEVSPACE_INHERITED_TEST='must-not-reach-child';
    const controller=createServiceController({platformRoot:f.root,configPath:f.configPath,tunnelTokenFile:f.tokenFile},{platform:'win32',spawnProcess,runCommand,createProcessJob});
    assert.equal(controller.autostartAvailable,false);
    assert.throws(()=>setAutostart({},true,controller),/unavailable/);
    const starts=await Promise.all([controller.action('devspace','start','Remote'),controller.action('devspace','start','Remote')]);
    assert.deepEqual(starts.map(result=>result.ok),[true,true]);
    assert.equal(spawned.length,1);
    assert.match(spawned[0].command,/runtime[/\\]slots[/\\]slot-a[/\\]node[/\\]node\.exe$/);
    assert.match(spawned[0].args[0],/@waishnav[/\\]devspace[/\\]dist[/\\]cli\.js$/);
    assert.deepEqual(spawned[0].args.slice(1),['serve']);
    assert.equal(spawned[0].options.env.DEVSPACE_CONFIG_DIR,path.dirname(f.configPath));
    assert.equal(spawned[0].options.env.DEVSPACE_INHERITED_TEST,undefined);
    assert.equal(process.env.DEVSPACE_INHERITED_TEST,'must-not-reach-child');
    assert.equal(spawned[0].options.env.DEVSPACE_COMPACT_RUN_ROOT,path.join(f.root,'state','devspace-state','compact-runs'));
    assert.equal(spawned[0].options.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS,'30');
    assert.equal(spawned[0].options.env.DEVSPACE_COMPACT_LOG_MAX_BYTES,'2147483648');
    assert.ok(spawned[0].options.env.PATH.startsWith(path.join(f.root,'runtime','slots','slot-a','serena','bin')+';'+path.join(f.root,'runtime','slots','slot-a','uv')+';'));
    assert.equal(controller.state('devspace').pid,7001);
    assert.equal((await controller.action('tunnel','start','Remote')).ok,true);
    assert.match(spawned[1].command,/node\.exe$/);
    assert.match(spawned[1].args[0],/managed-cloudflared\.mjs$/);
    assert.ok(spawned[1].args.includes(f.tokenFile));
    assert.equal(spawned[1].args[spawned[1].args.indexOf('--protocol')+1],'http2');
    assert.equal(spawned[1].args.includes('synthetic-token-value'),false);
    assert.deepEqual(jobEvents,[['add',7001],['add',7002]]);
    spawned[1].child.stderr.emit('data',Buffer.from('secret synthetic-token-value\n'));
    assert.doesNotMatch(controller.log('tunnel'),/synthetic-token-value/);
    assert.match(controller.log('tunnel'),/\[REDACTED\]/);
    assert.equal((await controller.action('tunnel','stop','Remote')).ok,true);
    assert.deepEqual(commands.at(-1),['taskkill','/PID','7002','/T','/F']);
    assert.equal(controller.state('tunnel').pid,null);
    const refusal=await controller.action('tunnel','stop','Remote');
    assert.equal(refusal.ok,false);
    assert.match(refusal.stderr,/No live process owned/);
    writeFileSync(path.join(f.root,'state','control-settings.json'),JSON.stringify({schema_version:1,tunnel_mode:'Quick'}));
    writeFileSync(path.join(f.root,'state','quick-tunnel-url.txt'),'https://sample.trycloudflare.com\n');
    assert.equal((await controller.action('devspace','restart','Quick')).ok,true);
    assert.ok(commands.some(x=>x[1]?.endsWith('prepare-effective-config.mjs')));
    assert.equal(spawned.at(-1).options.env.DEVSPACE_CONFIG_DIR,path.join(f.root,'state','effective-config'));
    assert.deepEqual(jobEvents,[['add',7001],['add',7002],['add',7003]]);
    assert.equal((await controller.action('tunnel','start','Quick')).ok,true);
    assert.match(spawned.at(-1).args[0],/managed-cloudflared\.mjs$/);
    assert.ok(spawned.at(-1).args.includes(path.join(f.root,'state','quick-tunnel-url.txt')));
    await controller.shutdown();
    assert.deepEqual(jobEvents,[['add',7001],['add',7002],['add',7003],['add',7004],['close']]);
    assert.equal(controller.state('devspace').pid,null);
    assert.equal(controller.state('tunnel').pid,null);
    await controller.shutdown();
    assert.equal(jobEvents.filter(x=>x[0]==='close').length,1);
  }finally{delete process.env.DEVSPACE_INHERITED_TEST;f.clean();}
});

test('Windows controller rejects an invalid persisted Tunnel protocol before launch',async()=>{
  const f=fixture();
  const spawned=[];
  try{
    writeFileSync(path.join(f.root,'settings.json'),JSON.stringify({CloudflaredProtocol:'invalid'}));
    const controller=createServiceController({platformRoot:f.root,configPath:f.configPath,tunnelTokenFile:f.tokenFile},{
      platform:'win32',spawnProcess:(...args)=>{spawned.push(args);throw new Error('must not spawn');},
      createProcessJob:()=>({addPid:()=>{},close:()=>{}}),
      runCommand:()=>({ok:true,status:0,stdout:'',stderr:''}),
    });
    const result=await controller.action('tunnel','start','Remote');
    assert.equal(result.ok,false);
    assert.match(result.stderr,/Invalid Windows Tunnel protocol setting/);
    assert.equal(spawned.length,0);
  }finally{f.clean();}
});

test('Windows Job assignment failure refuses ownership and confirms candidate termination',async()=>{
  const f=fixture();
  const child=new EventEmitter();
  Object.assign(child,{pid:8100,exitCode:null,signalCode:null,killed:false,stdout:new EventEmitter(),stderr:new EventEmitter()});
  const calls=[];
  const controller=createServiceController({platformRoot:f.root,configPath:f.configPath},{
    platform:'win32',spawnProcess:()=>child,
    createProcessJob:()=>({addPid:()=>{throw new Error('synthetic assignment failure');},close:()=>calls.push('close')}),
    runCommand:(command,args)=>{
      calls.push([command,...args]);
      queueMicrotask(()=>{child.exitCode=1;child.emit('exit',1,null);});
      return {ok:true,status:0,stdout:'',stderr:''};
    }
  });
  try{
    const result=await controller.action('devspace','start','Remote');
    assert.equal(result.ok,false);
    assert.match(result.stderr,/ownership refused/);
    assert.equal(controller.state('devspace').pid,null);
    assert.deepEqual(calls[0],['taskkill','/PID','8100','/T','/F']);
    await controller.shutdown();
    assert.equal(calls.at(-1),'close');
  }finally{f.clean();}
});

test('Windows shutdown keeps Job open when a child stop is not confirmed',async()=>{
  const f=fixture();
  const child=new EventEmitter();
  Object.assign(child,{pid:8200,exitCode:null,signalCode:null,killed:false,stdout:new EventEmitter(),stderr:new EventEmitter()});
  let closed=false;
  const controller=createServiceController({platformRoot:f.root,configPath:f.configPath},{
    platform:'win32',spawnProcess:()=>child,
    createProcessJob:()=>({addPid:()=>{},close:()=>{closed=true;}}),
    runCommand:()=>({ok:false,status:1,stdout:'',stderr:'synthetic stop failure'})
  });
  try{
    assert.equal((await controller.action('devspace','start','Remote')).ok,true);
    await assert.rejects(controller.shutdown(),/Unable to stop owned process tree/);
    assert.equal(closed,false);
    assert.equal(controller.state('devspace').pid,8200);
  }finally{f.clean();}
});

test('management core uses injected controller without platform spoofing',async()=>{
  const f=fixture();
  const calls=[];
  const controller={
    autostartAvailable:false,
    available:()=>true,
    state:name=>({status:name==='devspace'?'active':'inactive',enabled:'disabled',pid:name==='devspace'?88:null}),
    action:async(name,action,mode)=>{calls.push([name,action,mode]);return {ok:true,status:0,stderr:''};},
    log:()=>''
  };
  try{
    const options={platformRoot:f.root,configPath:f.configPath};
    const snap=managementSnapshot(options,{actual:{version:'test'}},{},controller);
    assert.equal(snap.services.devspace.pid,88);
    assert.equal(snap.settings.auto_start,null);
    assert.equal(snap.settings.auto_start_available,false);
    assert.equal((await serviceAction(options,'tunnel','start',controller)).ok,true);
    assert.deepEqual(calls,[['tunnel','start','Remote']]);
  }finally{f.clean();}
});

test('Quick Tunnel restart cannot bypass the Runtime job guard',async()=>{
  const f=fixture();
  const stateDir=path.join(f.root,'state','devspace-state');
  const jobs=path.join(stateDir,'jobs');mkdirSync(jobs,{recursive:true});
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path.join(jobs,'jobs.sqlite'));
  db.exec('CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
  db.prepare('INSERT INTO durable_jobs VALUES (?,?)').run('job-running','running');
  db.close();
  writeFileSync(path.join(f.root,'state','control-settings.json'),JSON.stringify({schema_version:1,tunnel_mode:'Quick'}));
  const calls=[];
  const controller={available:()=>true,state:()=>({status:'active'}),action:async(...args)=>{calls.push(args);return {ok:true};}};
  try{
    const result=await serviceAction({platformRoot:f.root,configPath:f.configPath,stateDir},'tunnel','restart',controller);
    assert.equal(result.reason_code,'active_jobs');
    assert.deepEqual(calls,[]);
  }finally{f.clean();}
});

test('release and install scripts include controller and Windows helpers/token path',()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const read=file=>readFileSync(path.join(root,file),'utf8');
  for(const file of ['package-release-linux.sh','package-release-windows-payload.ps1','setup-linux.sh','ops/install-linux-sidecar-instance.sh'])
    assert.match(read(file),/control-service-controller\.mjs/,file);
  for(const file of ['package-release-linux.sh','package-release-windows-payload.ps1','setup-linux.sh','ops/install-linux-sidecar-instance.sh'])
    assert.match(read(file),/windows-process-job\.mjs/,file);
  const windows=read('package-release-windows-payload.ps1');
  assert.match(windows,/managed-cloudflared\.mjs/);
  assert.match(windows,/prepare-effective-config\.mjs/);
  assert.match(read('ops/start-runtime-console.ps1'),/state\\secrets\\cloudflare-tunnel-token\.txt/);
  assert.equal(existsSync(path.join(root,'ops','control-service-controller.mjs')),true);
});
