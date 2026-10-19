/** Immutable Runtime slots and the instance's atomic selection. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { runtimeRestartPreflight, withRuntimeRestartGuard } from './runtime-jobs-guard.mjs';

const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const slotId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
export const RUNTIME_SERVICE_RESTART_TIMEOUT_MS=120_000;

export function runtimeStateDirectory(options) {
  if(options.configPath&&existsSync(options.configPath)) {
    const raw=readFileSync(options.configPath,'utf8').replace(/^\uFEFF/,'');
    let state;
    try{state=JSON.parse(raw).storage?.stateDir;}
    catch {
      const matches=[...raw.matchAll(/"stateDir"\s*:\s*("(?:\\.|[^"\\])*")/g)];
      if(matches.length>1||(!matches.length&&raw.includes('"stateDir"')))throw new Error('Ambiguous Runtime state directory.');
      state=matches.length?JSON.parse(matches[0][1]):undefined;
    }
    if(state===undefined)return options.stateDir||path.join(options.platformRoot,'state','devspace-state');
    if(typeof state!=='string'||!path.isAbsolute(state))throw new Error('Runtime state directory is unavailable.');
    if(options.stateDir&&path.resolve(options.stateDir)!==path.resolve(state))throw new Error('Runtime state directories disagree.');
    return state;
  }
  return options.stateDir||path.join(options.platformRoot,'state','devspace-state');
}
export const selectionPath=options=>path.join(runtimeStateDirectory(options),'runtime-selection.json');
export const slotRoot=(root,id)=>{
  if(!slotId(id))throw new Error('Invalid Runtime slot ID.');
  return path.join(path.resolve(root),'runtime','slots',id);
};
export const slotPackage=(root,id)=>path.join(slotRoot(root,id),'devspace','node_modules','@waishnav','devspace');
export const slotNode=(root,id)=>path.join(slotRoot(root,id),'node',process.platform==='win32'?'node.exe':'bin/node');

function atomicJson(file,data) {
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.tmp-'+randomUUID();
  const fd=openSync(temp,'wx',0o600);
  try {writeFileSync(fd,JSON.stringify(data,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,file);
  if(process.platform!=='win32') {
    const dir=openSync(path.dirname(file),'r');
    try{fsyncSync(dir);}finally{closeSync(dir);}
  }
}
export function readRuntimeSelection(options) {
  const file=selectionPath(options);
  if(!existsSync(file))return null;
  const selected=JSON.parse(readFileSync(file,'utf8'));
  if(selected.schema_version!==1||!slotId(selected.slot)||!(/^[a-f0-9]{64}$/).test(selected.server_sha256)||
    (selected.previous!==null&&(!slotId(selected.previous?.slot)||!(/^[a-f0-9]{64}$/).test(selected.previous?.server_sha256))))
    throw new Error('Invalid Runtime selection; inspect the preserved transaction evidence.');
  return selected;
}
export function writeRuntimeSelection(options,selection) {
  atomicJson(selectionPath(options),selection);
  // Older desktop launchers/binaries still consume this non-authoritative mirror.
  const mirror=path.join(options.platformRoot,'runtime','active-slot.txt');
  mkdirSync(path.dirname(mirror),{recursive:true});
  const temp=mirror+'.tmp-'+randomUUID();
  const fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,selection.slot+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,mirror);
}

// Hash the complete staged file set, including link targets and executable bits.
function fileSet(root,topNames=null) {
  const files=Object.create(null);
  const walk=(dir,prefix='')=>{
    for(const name of (!prefix&&topNames?topNames:readdirSync(dir)).sort()) {
      if(!prefix&&['READY','slot-manifest.json'].includes(name))continue;
      const relative=prefix+name,file=path.join(dir,name),st=lstatSync(file);
      if(st.isSymbolicLink()) {
        if(!realpathSync(file).startsWith(realpathSync(root)+path.sep))throw new Error('Runtime link escapes its slot.');
        files[relative]='link:'+readlinkSync(file);
      }else if(st.isDirectory())walk(file,relative+'/');
      else if(st.isFile())files[relative]=sha256(file)+':'+(st.mode&0o111);
      else throw new Error('Unsupported Runtime file type.');
    }
  };
  walk(root);return files;
}
const sameFiles=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&a[key]===b[key]);
export function validateRuntimeSlot(options,id,{dryRun=launcherDryRun}={}) {
  const root=slotRoot(options.platformRoot,id),pkg=slotPackage(options.platformRoot,id);
  // A symlinked install root is legitimate; only the slot entry itself must
  // not be a link, and its real path must stay inside the real slots dir.
  if(lstatSync(root).isSymbolicLink()||!statSync(root).isDirectory())throw new Error('Runtime slot is not a real directory.');
  if(realpathSync(root)!==path.join(realpathSync(path.dirname(root)),path.basename(root)))
    throw new Error('Runtime slot must not escape its managed slots directory.');
  for(const file of [slotNode(options.platformRoot,id),path.join(pkg,'package.json'),path.join(pkg,'dist','cli.js'),path.join(pkg,'dist','server.js'),path.join(root,'READY')])
    if(!lstatSync(file).isFile())throw new Error('Runtime slot file set is incomplete.');
  const manifest=JSON.parse(readFileSync(path.join(root,'slot-manifest.json'),'utf8'));
  if(!manifest.files||!sameFiles(fileSet(root),manifest.files))throw new Error('Runtime slot file set/hash validation failed.');
  const hash=sha256(path.join(pkg,'dist','server.js'));
  const version=JSON.parse(readFileSync(path.join(pkg,'package.json'),'utf8')).version;
  if(typeof version!=='string'||manifest.server_sha256!==hash||manifest.version!==version)throw new Error('Runtime slot identity validation failed.');
  dryRun(slotNode(options.platformRoot,id),path.join(pkg,'dist','cli.js'),version);
  return {id,package_root:pkg,server_sha256:hash,version,verified:true};
}
function launcherDryRun(node,cli,version) {
  const r=spawnSync(node,[cli,'--version'],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(r.error||r.status!==0||!r.stdout?.includes(version))throw new Error('Runtime launcher dry-run failed.');
}
function validateLauncher(options,selection) {
  const launcher=path.join(options.platformRoot,'bin','run-devspace');
  const result=spawnSync('bash',[launcher,'--dry-run'],{encoding:'utf8',timeout:15000});
  const expected=slotNode(options.platformRoot,selection.slot)+'\n'+path.join(slotPackage(options.platformRoot,selection.slot),'dist','cli.js');
  if(result.error||result.status!==0||result.stdout?.trim()!==expected)throw new Error('The service launcher dry-run does not match Runtime selection.');
}
export function stageRuntimeSlot(options,source,{copy=cpSync,dryRun=launcherDryRun}={}) {
  const id='slot-'+randomUUID(),target=slotRoot(options.platformRoot,id);
  mkdirSync(path.dirname(target),{recursive:true});
  mkdirSync(target); // Never merge into, overwrite or remove an existing slot.
  const before=fileSet(source,['node','devspace']);
  for(const name of ['node','devspace'])copy(path.join(source,name),path.join(target,name),{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
  if(!sameFiles(before,fileSet(target)))throw new Error('Runtime copy/file set validation failed; staged evidence retained.');
  const pkg=slotPackage(options.platformRoot,id);
  atomicJson(path.join(target,'slot-manifest.json'),{files:before,server_sha256:sha256(path.join(pkg,'dist','server.js')),version:JSON.parse(readFileSync(path.join(pkg,'package.json'),'utf8')).version});
  writeFileSync(path.join(target,'READY'),'ready\n',{flag:'wx'});
  return validateRuntimeSlot(options,id,{dryRun});
}

export function restartUserService(unit,runner=spawnSync) {
  const result=runner('systemctl',['--user','restart',unit],{encoding:'utf8',timeout:RUNTIME_SERVICE_RESTART_TIMEOUT_MS,windowsHide:true});
  if(result.error?.code==='ETIMEDOUT')throw new Error('The service restart confirmation timed out.');
  if(result.error||result.status!==0)throw new Error('The service restart command did not succeed.');
}
function processForService(unit) {
  const r=spawnSync('systemctl',['--user','show',unit,'-p','MainPID','--value'],{encoding:'utf8',timeout:3000});
  if(r.error||r.status!==0||!/^\d+$/.test(r.stdout?.trim())) {
    const state=spawnSync('systemctl',['--user','show',unit,'-p','LoadState','-p','ActiveState'],{encoding:'utf8',timeout:3000});
    if(!state.error&&/^LoadState=not-found$/m.test(state.stdout||'')&&/^ActiveState=inactive$/m.test(state.stdout||''))return null;
    throw new Error('Runtime process identity is unavailable.');
  }
  const pid=Number(r.stdout.trim());
  if(pid===0)return null;
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Invalid Runtime PID.');
  return {pid,package_root:packageForPid(pid),start_identity:processStart(pid)};
}
function packageForPid(pid) {
  const cli=readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').find(x=>x.endsWith('/node_modules/@waishnav/devspace/dist/cli.js'));
  if(!cli)throw new Error('Runtime process command line is unavailable.');
  return path.dirname(path.dirname(cli));
}
function processStart(pid) {
  const stat=readFileSync('/proc/'+pid+'/stat','utf8');
  return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
}
export function stopUserService(unit,live,runner=spawnSync) {
  const result=runner('systemctl',['--user','stop',unit],{encoding:'utf8',timeout:RUNTIME_SERVICE_RESTART_TIMEOUT_MS,windowsHide:true});
  if(result.error||result.status!==0)throw new Error('Runtime stop failed; exit is unconfirmed.');
  const r=runner('systemctl',['--user','show',unit,'-p','MainPID','--value'],{encoding:'utf8',timeout:3000});
  if(r.error||r.status!==0||r.stdout?.trim()!=='0')throw new Error('Runtime stop could not be confirmed.');
  if(live?.pid&&existsSync('/proc/'+live.pid)) {
    if(!live.start_identity||processStart(live.pid)===live.start_identity)throw new Error('Old Runtime process still exists after stop.');
  }
}

async function waitForTarget(probe,target,attempts,interval) {
  for(let n=0;n<attempts;n++){if(await probe(target))return;await pause(interval);}
  throw new Error('The target failed live-process and local MCP health checks.');
}
export async function switchRuntime({options,target,expectedHash,observedPid,probe,
  restart=restartUserService,stop=stopUserService,readLive=()=>processForService(options.serviceUnit),
  dryRun=launcherDryRun,platform=process.platform,probeAttempts=40,probeIntervalMs=500,guardHeld=false,offline=false,legacyPackage='',allowStopped=false}) {
  if(platform==='win32')return {ok:false,status:409,error:'Windows runtime switching is not configured.'};
  const action=async()=>{
    // The installer can hold the gate for minutes; a job recorded during that
    // time must still block the switch before any process is stopped.
    if(guardHeld) {
      const state=await runtimeRestartPreflight({...options,stateDir:runtimeStateDirectory(options)});
      if(!state.ok)return state;
    }
    let previous,verified,live;
    try {
      previous=readRuntimeSelection(options);
      if(!previous)throw new Error('Runtime selection is missing; run the installer to migrate the launcher.');
      live=readLive();
      if(offline&&live)throw new Error('Cannot select offline while a Runtime process is running.');
      if(!offline&&!(allowStopped&&!live)&&(!live||live.pid!==observedPid||
        (live.package_root!==slotPackage(options.platformRoot,previous.slot)&&
          (!legacyPackage||live.package_root!==legacyPackage||sha256(path.join(legacyPackage,'dist','server.js'))!==previous.server_sha256))))throw new Error('The running process changed; refresh before selecting a target.');
      const launcher=readFileSync(path.join(options.platformRoot,'bin','run-devspace'),'utf8');
      if(!launcher.includes('runtime-rollback.mjs')||!launcher.includes('--resolve'))throw new Error('The service launcher does not match the selection contract.');
      validateLauncher(options,previous);
      if(validateRuntimeSlot(options,previous.slot,{dryRun}).server_sha256!==previous.server_sha256)throw new Error('Current Runtime selection hash mismatch.');
      verified=validateRuntimeSlot(options,target?.id,{dryRun});
      if(verified.id===previous.slot||verified.server_sha256!==expectedHash)throw new Error('Selected runtime changed after the preview.');
    }catch(error){return {ok:false,status:409,error:error.message};}
    const folder=path.join(runtimeStateDirectory(options),'runtime-rollback'),id=randomUUID();
    mkdirSync(folder,{recursive:true,mode:0o700});
    const evidence=path.join(folder,id+'.json');
    const next={schema_version:1,slot:verified.id,server_sha256:verified.server_sha256,previous:{slot:previous.slot,server_sha256:previous.server_sha256}};
    atomicJson(evidence,{phase:'prepared',previous,next});
    // Even a rename followed by a directory-fsync failure requires recovery.
    try {
      writeRuntimeSelection(options,next);
      validateLauncher(options,next);
      if(!offline) {
        await stop(options.serviceUnit,live);
        await restart(options.serviceUnit);
        await waitForTarget(probe,verified,probeAttempts,probeIntervalMs);
      }
      atomicJson(evidence,{phase:'completed',previous,next});
      return {ok:true,status:200,target_id:verified.id,version:verified.version,backup_id:id,health:offline?'offline':'verified'};
    }catch(error) {
      let restored=false,recovery_error=null;
      try {
        writeRuntimeSelection(options,previous);
        if(!offline) {
          await stop(options.serviceUnit,readLive());
          await restart(options.serviceUnit);
          await waitForTarget(probe,validateRuntimeSlot(options,previous.slot,{dryRun}),probeAttempts,probeIntervalMs);
        }
        restored=true;
      }catch(recovery){recovery_error=recovery.message;}
      const reason_code=error.message==='The service restart confirmation timed out.'?'restart_timeout':error.message.includes('health checks')?'target_not_healthy':'switch_failed';
      atomicJson(evidence,{phase:restored?'restored':'recovery_failed',previous,next,error:error.message,recovery_error});
      return {ok:false,status:500,error:error.message,reason_code,restored,recovery_error,backup_id:id};
    }
  };
  return guardHeld?action():withRuntimeRestartGuard({...options,stateDir:runtimeStateDirectory(options)},action);
}

// config.jsonc is JSONC. Strict JSON stays the fast path; comments/trailing
// commas use the same bundled jsonc-parser the installer already relies on.
function readRuntimeConfig(file,packageRoot) {
  const raw=readFileSync(file,'utf8').replace(/^\uFEFF/,'');
  try { return JSON.parse(raw); }
  catch (jsonError) {
    let value,parseError;
    try {
      const load=createRequire(path.join(packageRoot,'package.json'));
      const errors=[];
      value=load('jsonc-parser').parse(raw,errors,{allowTrailingComma:true,disallowComments:false});
      if(errors.length)parseError=new Error('JSONC parse error at offset '+errors[0].offset);
    }catch(error) { parseError=error; }
    if(parseError)throw new Error('Unable to parse '+file+': '+parseError.message);
    return value;
  }
}

export async function localRuntimeProbe(options,target,{readLive=()=>processForService(options.serviceUnit)}={}) {
  let live;
  try { live=readLive(); } catch { return false; }
  if(!live||live.package_root!==target.package_root)return false;
  if(target.server_sha256&&sha256(path.join(target.package_root,'dist','server.js'))!==target.server_sha256)return false;
  // A parse failure is configuration evidence, not "unhealthy"; let it reach
  // the caller instead of retrying a probe that can never succeed.
  const config=readRuntimeConfig(options.configPath,target.package_root);
  const port=config?.server?.port;
  if(!Number.isSafeInteger(port))return false;
  try {
    const base=new URL(config.server.publicBaseUrl||'http://localhost');
    const url='http://127.0.0.1:'+port+base.pathname.replace(/\/+$/,'')+'/healthz';
    const ac=new AbortController(),timeout=setTimeout(()=>ac.abort(),2000);
    try {const response=await fetch(url,{signal:ac.signal,redirect:'manual'});return response.status===200&&(await response.json()).ok===true;}
    finally{clearTimeout(timeout);}
  }catch{return false;}
}

async function main(args) {
  const [command,root,config,...rest]=args;
  const options={platformRoot:root,configPath:config};
  if(command==='--describe') {
    const selected=readRuntimeSelection(options);
    const pointer=path.join(root,'runtime','active-slot.txt');
    const id=selected?.slot||(!selected&&existsSync(pointer)?readFileSync(pointer,'utf8').trim():'');
    if(id&&!slotId(id))throw new Error('Invalid legacy Runtime slot.');
    const dir=id?slotRoot(root,id):path.join(root,'runtime');
    const pkg=id?slotPackage(root,id):[rest[0],path.join(dir,'devspace','node_modules','@waishnav','devspace'),path.join(dir,'node_modules','@waishnav','devspace')].filter(Boolean).find(p=>existsSync(path.join(p,'package.json')))||'';
    const node=id?slotNode(root,id):path.join(dir,'node','bin','node');
    if(selected&&(![node,path.join(dir,'READY'),path.join(pkg,'package.json'),path.join(pkg,'dist','cli.js'),path.join(pkg,'dist','server.js')].every(file=>existsSync(file)&&lstatSync(file).isFile())||sha256(path.join(pkg,'dist','server.js'))!==selected.server_sha256))throw new Error('Selected Runtime hash/readiness mismatch; legacy mirror was not used.');
    console.log([existsSync(node)?node:process.execPath,pkg,id,runtimeStateDirectory(options)].join('\n'));return;
  }
  if(command==='--resolve') {
    const selected=readRuntimeSelection(options);
    if(!selected)throw new Error('Runtime selection is missing.');
    const pkg=slotPackage(root,selected.slot);
    if(sha256(path.join(pkg,'dist','server.js'))!==selected.server_sha256)throw new Error('Selected Runtime hash mismatch.');
    console.log(slotNode(root,selected.slot)+'\n'+path.join(pkg,'dist','cli.js'));return;
  }
  if(command==='--stage'){console.log(stageRuntimeSlot(options,rest[0]).id);return;}
  if(command==='--install-guard') {
    const [unit,script,...scriptArgs]=rest;
    options.serviceUnit=unit;
    const stateDir=runtimeStateDirectory(options);
    const result=await withRuntimeRestartGuard({...options,stateDir},async()=>{
      const before=readRuntimeSelection(options),live=processForService(unit);
      const launcher=path.join(root,'bin','run-devspace');
      const priorLauncher=existsSync(launcher)?readFileSync(launcher):null;
      const evidence=path.join(stateDir,'runtime-rollback','install-'+randomUUID());
      mkdirSync(evidence,{recursive:true,mode:0o700});
      atomicJson(path.join(evidence,'before.json'),{selection:before,live});
      if(priorLauncher)copyFileSync(launcher,path.join(evidence,'run-devspace.bak'));
      let childResult;
      try {
        childResult=await new Promise((resolve,reject)=>{
          const child=spawn('bash',[script,...scriptArgs],{stdio:'inherit',env:{...process.env,DSF_INSTALL_GUARD_PID:String(process.pid)}});
          child.on('error',reject);child.on('exit',(code,signal)=>resolve({ok:code===0,status:code||1,error:signal?'Installer terminated by '+signal:'Installer failed.'}));
        });
      }catch(error){childResult={ok:false,error:error.message};}
      if(childResult.ok)return childResult;
      let recovery_error=null;
      try {
        const after=readRuntimeSelection(options);
        const changed=JSON.stringify(after)!==JSON.stringify(before)||
          (priorLauncher?existsSync(launcher)&&!readFileSync(launcher).equals(priorLauncher):existsSync(launcher));
        if(changed) {
          if(before)writeRuntimeSelection(options,before);
          else {
            // Fresh install: nothing existed before, so remove the selections
            // and launcher the failed child installed instead of leaving them
            // pointing at a Runtime that is no longer running.
            if(existsSync(selectionPath(options)))renameSync(selectionPath(options),path.join(evidence,'failed-selection.json'));
            const mirror=path.join(root,'runtime','active-slot.txt');
            if(existsSync(mirror))renameSync(mirror,path.join(evidence,'failed-active-slot.txt'));
            if(existsSync(launcher))renameSync(launcher,path.join(evidence,'failed-run-devspace'));
          }
          if(priorLauncher) {
            const temp=launcher+'.restore-'+randomUUID();
            writeFileSync(temp,priorLauncher,{mode:0o755,flag:'wx'});renameSync(temp,launcher);
          }
          stopUserService(unit,processForService(unit));
          if(live) {
            restartUserService(unit);
            await waitForTarget(t=>localRuntimeProbe(options,t),live,40,500);
          }
        }
      }catch(error){recovery_error=error.message;}
      atomicJson(path.join(evidence,'failure.json'),{error:childResult.error,recovery_error});
      return {ok:false,error:childResult.error+' Recovery evidence: '+evidence+(recovery_error?'; recovery failed: '+recovery_error:'')};
    });
    if(!result.ok)throw new Error(result.error||'Installer failed; inspect preserved slot/transaction evidence.');
    return;
  }
  if(command==='--activate') {
    const [id,unit,start]=rest;
    const owner=JSON.parse(readFileSync(path.join(runtimeStateDirectory(options),'.runtime-switch-gate','owner.json'),'utf8'));
    if(String(owner.pid)!==process.env.DSF_INSTALL_GUARD_PID)throw new Error('Installer gate is not held.');
    options.serviceUnit=unit;
    const target=validateRuntimeSlot(options,id);
    let previous=readRuntimeSelection(options),legacyPackage='';
    const live=processForService(unit);
    if(!previous&&existsSync(path.join(root,'runtime','node','bin','node'))) {
      legacyPackage=path.join(root,'runtime','devspace','node_modules','@waishnav','devspace');
      if(live&&live.package_root!==legacyPackage)throw new Error('Legacy Runtime identity is unknown; existing files were preserved.');
      const baseline=stageRuntimeSlot(options,path.join(root,'runtime'));
      previous={schema_version:1,slot:baseline.id,server_sha256:baseline.server_sha256,previous:null};
      writeRuntimeSelection(options,previous);
    }
    const pending=path.join(root,'bin','run-devspace.pending-'+id);
    if(existsSync(pending))renameSync(pending,path.join(root,'bin','run-devspace'));
    if(!previous) {
      if(processForService(unit))throw new Error('Legacy running Runtime must be migrated before selection; existing files were preserved.');
      writeRuntimeSelection(options,{schema_version:1,slot:id,server_sha256:target.server_sha256,previous:null});
      if(start==='1'){restartUserService(unit);await waitForTarget(t=>localRuntimeProbe(options,t),target,40,500);}
    }else {
      const result=await switchRuntime({options,target,expectedHash:target.server_sha256,observedPid:live?.pid,probe:t=>localRuntimeProbe(options,t),guardHeld:true,offline:start!=='1',allowStopped:true,legacyPackage});
      if(!result.ok)throw new Error(JSON.stringify(result));
    }
    return;
  }
  throw new Error('Unknown Runtime transaction command.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
