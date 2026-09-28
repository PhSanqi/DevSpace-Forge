/**
 * Cross-process gate for Runtime operations and durable-job launches.
 * The Runtime job manager uses the same atomic directory before launching.
 * True restart independence also requires a separate job cgroup.
 */
import { existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
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

export async function withRuntimeRestartGuard(options,action) {
  let stateDir;
  try { stateDir=resolveStateDir(options); }
  catch { return unavailable(); }
  if(!stateDir)return unavailable();
  const lock=path.join(stateDir,'.runtime-switch-gate');
  try {
    mkdirSync(stateDir,{recursive:true,mode:0o700});
    mkdirSync(lock);
  }catch {
    return {ok:false,status:409,reason_code:'runtime_switch_in_progress',error:'Runtime switch gate is unavailable or already held.'};
  }
  try {
    // A job launched after the UI preflight must still prevent the restart.
    const state=await runtimeRestartPreflight(options);
    if(!state.ok)return state;
    return await action();
  }finally {
    try { rmdirSync(lock); } catch {}
  }
}
