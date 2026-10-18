import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createWindowsProcessJob, windowsProcessJobPolicy } from '../ops/windows-process-job.mjs';

test('Windows process job policy preserves direct-child cleanup and durable-grandchild breakaway intent',()=>{
  assert.deepEqual(windowsProcessJobPolicy,{
    kill_on_job_close:true,
    silent_breakaway_ok:true,
  });
});

test('Windows process job fails closed on non-Windows hosts',{skip:process.platform==='win32'},()=>{
  assert.throws(()=>createWindowsProcessJob('/not-used-on-non-windows'),/only available on Windows/);
});

test('Windows Job can release a retained Runtime without killing it', {skip:process.platform!=='win32',timeout:10000},async()=>{
  const job=createWindowsProcessJob(fileURLToPath(new URL('../runtime-src',import.meta.url)));
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await once(child,'spawn');
  try{
    job.addPid(child.pid);
    job.close({preserveProcesses:true});
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(child.exitCode,null);
    assert.equal(process.kill(child.pid,0),true);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){
      const exited=once(child,'exit');
      child.kill();await exited;
    }
    job.close();
  }
});
