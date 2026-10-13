import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsProcessJob, windowsProcessJobPolicy } from '../ops/windows-process-job.mjs';

test('Windows process job policy preserves direct-child cleanup and durable-grandchild breakaway intent',()=>{
  assert.deepEqual(windowsProcessJobPolicy,{
    kill_on_job_close:true,
    silent_breakaway_ok:true,
  });
});

test('Windows process job fails closed on non-Windows hosts',()=>{
  if(process.platform==='win32')return;
  assert.throws(()=>createWindowsProcessJob('/not-used-on-non-windows'),/only available on Windows/);
});
