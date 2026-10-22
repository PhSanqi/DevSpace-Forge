/**
 * Cross-process gate for Runtime operations and durable-job launches.
 * The Runtime job manager uses the same atomic directory before launching.
 * True restart independence also requires a separate job cgroup.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const unavailable=()=>({ok:false,status:409,reason_code:'job_state_unavailable',error:'Durable job state could not be verified; Runtime operation was not started.'});

function resolveStateDir(options) {
  let stateDir=options.stateDir;
  if(!stateDir&&options.configPath&&existsSync(options.configPath)){
    const raw=readFileSync(options.configPath,'utf8').replace(/^\uFEFF/,'');
    try{stateDir=JSON.parse(raw)?.storage?.stateDir;}
    catch {
      // config.jsonc may carry comments/trailing commas; the state directory
      // is still a single absolute JSON string and must not be guessed.
      const matches=[...raw.matchAll(/"stateDir"\s*:\s*("(?:\\.|[^"\\])*")/g)];
      if(matches.length!==1)return null;
      stateDir=JSON.parse(matches[0][1]);
    }
    if(typeof stateDir!=='string'||!stateDir.trim())return null;
  }
  if(!stateDir)stateDir=path.join(options.platformRoot||process.cwd(),'state','devspace-state');
  return typeof stateDir==='string'&&path.isAbsolute(stateDir)?stateDir:null;
}

export async function runtimeRestartPreflight(options) {
  try {
    const stateDir=resolveStateDir(options);
    if(!stateDir)return unavailable();
    const jobsDir=path.join(stateDir,'jobs');
    const database=path.join(jobsDir,'jobs.sqlite');
    // A fresh instance has no jobs directory; a missing database inside an
    // existing jobs directory is not evidence that no jobs are running.
    if(!existsSync(database))return existsSync(jobsDir)?unavailable():{ok:true,active_job_count:0};
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(database,{readOnly:true});
    try {
      // Future lifecycle states must remain blocking, even if an old Runtime
      // has not yet reconciled a launch/cancellation into a terminal record.
      const count=db.prepare("SELECT count(*) AS total FROM durable_jobs WHERE status IN ('pending','running','cancelling')").get()?.total;
      if(!Number.isSafeInteger(count)||count<0)return unavailable();
      if(count>0)return {ok:false,status:409,reason_code:'active_jobs',active_job_count:count,error:'Durable jobs are running; Runtime operation was not started.'};
      return {ok:true,active_job_count:0};
    }finally{db.close();}
  }catch{return unavailable();}
}

// Keep publication/release/recovery in sync with
// runtime-src/src/runtime-switch-gate.ts and src/SetupInstaller.cs.
function processStartIdentity(pid) {
  try {
    if(process.platform==='linux') {
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if(fields[0]==='Z'||fields[0]==='X')return null;
      return fields[19]?`linux:${fields[19]}`:null;
    }
    if(process.platform==='win32') {
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
        {encoding:'utf8',windowsHide:true,timeout:5000});
      const ticks=result.stdout?.trim();
      return result.status===0&&/^\d+$/.test(ticks)?`windows:${ticks}`:null;
    }
    if(process.platform==='darwin') {
      const result=spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:2000});
      return result.status===0&&result.stdout?.trim()?`ps:${result.stdout.trim()}`:null;
    }
  }catch{}
  return null;
}

// A PID alone is not ownership; a recycled PID has a different start identity.
function ownedProcessState(pid,identity) {
  if(!Number.isSafeInteger(pid)||pid<1)return 'unknown';
  const current=processStartIdentity(pid);
  if(current&&identity)return current===identity?'active':'inactive';
  try {
    process.kill(pid,0);
    if(process.platform==='linux') {
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
      if(/^[ZX] /.test(stat.slice(stat.lastIndexOf(')')+2)))return 'inactive';
    }
  }catch(error) { if(error.code==='ESRCH')return 'inactive'; }
  return 'unknown';
}

function readGateOwner(lock) {
  const owner=JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8'));
  if(!Number.isSafeInteger(owner.pid)||owner.pid<1||!Number.isFinite(owner.createdAt)||
    !(owner.processStartIdentity===null||typeof owner.processStartIdentity==='string')||
    !(owner.nonce===undefined||typeof owner.nonce==='string'))throw new Error('Invalid switch gate owner');
  return owner;
}

// A legacy publisher crashed between mkdir(gate) and owner.json publication.
// Keep this rule in sync with runtime-src/src/runtime-switch-gate.ts and
// src/SetupInstaller.cs: a real directory whose sole entry is an absent,
// empty or unparseable regular owner.json, with every timestamp older than
// the debris window, is reclaimable. A parseable owner stays blocking.
function legacyOwnerlessGateTimes(gate) {
  let info;
  try { info=lstatSync(gate); } catch { return null; }
  if(!info.isDirectory()||info.isSymbolicLink())return null;
  const times=[info.mtimeMs,info.ctimeMs];
  let entries;
  try { entries=readdirSync(gate); } catch { return null; }
  if(entries.length===0)return times;
  if(entries.length!==1||entries[0]!=='owner.json')return null;
  let fileInfo;
  try { fileInfo=lstatSync(path.join(gate,'owner.json')); } catch { return null; }
  // Legacy owner records are tiny; anything larger is not crash debris.
  if(!fileInfo.isFile()||fileInfo.isSymbolicLink()||fileInfo.size>4096)return null;
  times.push(fileInfo.mtimeMs,fileInfo.ctimeMs);
  let raw;
  try { raw=readFileSync(path.join(gate,'owner.json'),'utf8'); } catch { return null; }
  if(raw.length===0)return times;
  // A BOM-prefixed owner from an older .NET writer is still a parseable owner.
  try { JSON.parse(raw.replace(/^\uFEFF/,'')); return null; } catch { return times; }
}

export function reclaimLegacyOwnerlessGate(gate,now=Date.now()) {
  const times=legacyOwnerlessGateTimes(gate);
  if(!times||Math.max(...times)>=now-10*60_000)return false;
  const stale=`${gate}.stale-${randomUUID()}`;
  try {
    renameSync(gate,stale);
    if(legacyOwnerlessGateTimes(stale)) {
      rmSync(stale,{recursive:true,force:true});
      console.warn('Reclaimed legacy ownerless runtime switch gate');
      return true;
    }
    try { if(!existsSync(gate))renameSync(stale,gate); } catch {}
    return false;
  }catch {
    try { if(!existsSync(gate))renameSync(stale,gate); } catch {}
    return false;
  }
}

// Same protocol as runtime-src recoverSwitchGate: move the gate aside, verify
// the moved owner is still the one that was judged dead, then discard it.
function reclaimDeadGate(lock) {
  let owner;
  try { owner=readGateOwner(lock); } catch { return reclaimLegacyOwnerlessGate(lock); }
  if(ownedProcessState(owner.pid,owner.processStartIdentity)!=='inactive')return false;
  const stale=`${lock}.stale-${randomUUID()}`;
  try {
    renameSync(lock,stale);
    const moved=readGateOwner(stale);
    if(moved.nonce!==owner.nonce||moved.pid!==owner.pid||moved.createdAt!==owner.createdAt||
      moved.processStartIdentity!==owner.processStartIdentity) {
      try { if(!existsSync(lock))renameSync(stale,lock); } catch {}
      return false;
    }
    rmSync(stale,{recursive:true,force:true});
    return true;
  }catch {
    try { if(!existsSync(lock))renameSync(stale,lock); } catch {}
    return false;
  }
}

export async function withRuntimeRestartGuard(options,action) {
  let stateDir;
  try { stateDir=resolveStateDir(options); }
  catch { return unavailable(); }
  if(!stateDir)return unavailable();
  const lock=path.join(stateDir,'.runtime-switch-gate');
  const nonce=randomUUID();
  const temp=`${lock}.tmp-${process.pid}-${nonce}`;
  try {
    mkdirSync(stateDir,{recursive:true,mode:0o700});
    mkdirSync(temp,{mode:0o700});
    const fd=openSync(path.join(temp,'owner.json'),'wx',0o600);
    try {
      writeFileSync(fd,JSON.stringify({pid:process.pid,processStartIdentity:processStartIdentity(process.pid),createdAt:Date.now(),nonce}));
      fsyncSync(fd);
    }finally{closeSync(fd);}
    if(existsSync(lock)&&!reclaimDeadGate(lock))throw new Error('Gate already held');
    renameSync(temp,lock);
    if(JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8')).nonce!==nonce)throw new Error('Gate owner changed');
  }catch {
    return {ok:false,status:409,reason_code:'runtime_switch_in_progress',error:'Runtime switch gate is unavailable or already held.'};
  }finally {
    rmSync(temp,{recursive:true,force:true});
  }
  try {
    // A job launched after the UI preflight must still prevent the restart.
    const state=await runtimeRestartPreflight(options);
    if(!state.ok)return state;
    return await action();
  }finally {
    const released=`${lock}.released-${randomUUID()}`;
    for(let attempt=0;attempt<5;attempt++) {
      try { if(JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8')).nonce!==nonce)break; }
      catch { break; } // An uncertain owner must remain blocking.
      try { renameSync(lock,released); }
      catch {
        if(attempt<4) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20*(attempt+1));
          continue;
        }
        console.warn('Runtime switch gate release rename failed; removing the owned gate in place.');
        try {
          if(JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8')).nonce!==nonce)break;
          unlinkSync(path.join(lock,'owner.json'));
          rmdirSync(lock);
        }catch { console.warn('Runtime switch gate in-place release failed.'); }
        break;
      }
      try { rmSync(released,{recursive:true,force:true}); }
      catch { console.warn('Runtime switch gate released; debris removal failed.'); }
      break;
    }
  }
}
