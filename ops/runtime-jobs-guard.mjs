/**
 * Cross-process gate for Runtime operations and durable-job launches.
 * The Runtime job manager uses the same atomic directory before launching.
 * True restart independence also requires a separate job cgroup.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const unavailable=()=>({ok:false,status:409,reason_code:'job_state_unavailable',error:'Durable job state could not be verified; Runtime operation was not started.'});

function resolveStateDir(options) {
  let stateDir=options.stateDir;
  if(!stateDir&&options.configPath&&existsSync(options.configPath)){
    const config=JSON.parse(readFileSync(options.configPath,'utf8').replace(/^\uFEFF/,''));
    stateDir=config?.storage?.stateDir;
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

// Keep publication/release in sync with runtime-src/src/runtime-switch-gate.ts.
function ownerIdentity() {
  try {
    if(process.platform==='linux') {
      const stat=readFileSync(`/proc/${process.pid}/stat`,'utf8');
      const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
      return start?`linux:${start}`:null;
    }
    if(process.platform==='win32') {
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `$ErrorActionPreference='Stop'; (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
        {encoding:'utf8',windowsHide:true,timeout:5000});
      const ticks=result.stdout?.trim();
      return result.status===0&&/^\d+$/.test(ticks)?`windows:${ticks}`:null;
    }
    if(process.platform==='darwin') {
      const result=spawnSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',timeout:2000});
      return result.status===0&&result.stdout?.trim()?`ps:${result.stdout.trim()}`:null;
    }
  }catch{}
  return null;
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
      writeFileSync(fd,JSON.stringify({pid:process.pid,processStartIdentity:ownerIdentity(),createdAt:Date.now(),nonce}));
      fsyncSync(fd);
    }finally{closeSync(fd);}
    if(existsSync(lock))throw new Error('Gate already held');
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
