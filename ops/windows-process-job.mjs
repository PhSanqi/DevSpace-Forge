import { createRequire } from 'node:module';
import path from 'node:path';

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

let cachedBindings = null;

function loadBindings(runtimePackage) {
  if (process.platform !== 'win32') throw new Error('Windows process jobs are only available on Windows.');
  if (cachedBindings) return cachedBindings;
  const packageFile = path.join(path.resolve(runtimePackage || ''), 'package.json');
  const runtimeRequire = createRequire(packageFile);
  const koffi = runtimeRequire('koffi');

  const basic = koffi.struct('DevSpaceControlJobBasicLimitInformation', {
    PerProcessUserTimeLimit: 'int64_t',
    PerJobUserTimeLimit: 'int64_t',
    LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'uintptr_t',
    MaximumWorkingSetSize: 'uintptr_t',
    ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32_t',
    SchedulingClass: 'uint32_t',
  });
  const io = koffi.struct('DevSpaceControlJobIoCounters', {
    ReadOperationCount: 'uint64_t',
    WriteOperationCount: 'uint64_t',
    OtherOperationCount: 'uint64_t',
    ReadTransferCount: 'uint64_t',
    WriteTransferCount: 'uint64_t',
    OtherTransferCount: 'uint64_t',
  });
  const extended = koffi.struct('DevSpaceControlJobExtendedLimitInformation', {
    BasicLimitInformation: basic,
    IoInfo: io,
    ProcessMemoryLimit: 'uintptr_t',
    JobMemoryLimit: 'uintptr_t',
    PeakProcessMemoryUsed: 'uintptr_t',
    PeakJobMemoryUsed: 'uintptr_t',
  });
  const layout = {
    pointer: koffi.sizeof('void *'),
    basic: koffi.sizeof(basic),
    io: koffi.sizeof(io),
    extended: koffi.sizeof(extended),
  };
  if (layout.pointer !== 8 || layout.basic !== 64 || layout.io !== 48 || layout.extended !== 144) {
    throw new Error(`Unsupported Windows Job Object layout: ${JSON.stringify(layout)}`);
  }

  const kernel32 = koffi.load('kernel32.dll');
  cachedBindings = {
    koffi,
    extended,
    layout,
    createJob: kernel32.func('void * __stdcall CreateJobObjectW(void *lpJobAttributes, str16 lpName)'),
    setJobInfo: kernel32.func('bool __stdcall SetInformationJobObject(void *hJob, uint32_t infoClass, DevSpaceControlJobExtendedLimitInformation *info, uint32_t infoLength)'),
    assignProcess: kernel32.func('bool __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t desiredAccess, bool inheritHandle, uint32_t processId)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *handle)'),
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
  };
  return cachedBindings;
}

function emptyExtendedInfo() {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
}

export function createWindowsProcessJob(runtimePackage) {
  const bindings = loadBindings(runtimePackage);
  let handle = bindings.createJob(null, null);
  if (!handle) throw new Error(`CreateJobObjectW failed with Win32 error ${bindings.getLastError()}.`);
  const info = emptyExtendedInfo();
  if (!bindings.setJobInfo(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, bindings.layout.extended)) {
    const code = bindings.getLastError();
    bindings.closeHandle(handle);
    throw new Error(`SetInformationJobObject failed with Win32 error ${code}.`);
  }

  return {
    layout: { ...bindings.layout },
    addPid(pid) {
      if (!handle) throw new Error('Windows process job is closed.');
      const processId = Number(pid);
      if (!Number.isSafeInteger(processId) || processId < 1) throw new Error('Invalid Windows process id.');
      const processHandle = bindings.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, processId);
      if (!processHandle) throw new Error(`OpenProcess failed with Win32 error ${bindings.getLastError()}.`);
      try {
        if (!bindings.assignProcess(handle, processHandle)) {
          throw new Error(`AssignProcessToJobObject failed with Win32 error ${bindings.getLastError()}.`);
        }
      } finally {
        bindings.closeHandle(processHandle);
      }
    },
    close() {
      if (!handle) return;
      const closing = handle;
      handle = null;
      if (!bindings.closeHandle(closing)) throw new Error(`CloseHandle(job) failed with Win32 error ${bindings.getLastError()}.`);
    },
  };
}

export const windowsProcessJobPolicy = Object.freeze({
  kill_on_job_close: true,
  silent_breakaway_ok: true,
});
