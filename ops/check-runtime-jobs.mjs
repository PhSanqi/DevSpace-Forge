#!/usr/bin/env node
// Installer preflight, run while the native installer owns the shared gate.
// Only a status code/reason is emitted. Never print jobs, commands or secrets.
import path from 'node:path';
import { runtimeRestartPreflight } from './runtime-jobs-guard.mjs';

const stateDir=process.argv[2];
if(!stateDir||!path.isAbsolute(stateDir)){
  console.error('invalid_state_dir');
  process.exitCode=3;
}else{
  const result=await runtimeRestartPreflight({stateDir});
  if(!result.ok){
    console.error(result.reason_code||'job_state_unavailable');
    process.exitCode=3;
  }else{
    console.log('jobs_clear');
  }
}
