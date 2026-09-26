/**
 * Explicit operator-triggered runtime switch. Selection is an inventory ID,
 * never a caller-supplied filesystem path or an arbitrary shell command.
 * The console service remains independent from the runtime being restarted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sha256=(file)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const pause=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

function restartUserService(unit) {
  const result=spawnSync('systemctl',['--user','restart',unit],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(result.status!==0)throw new Error('The service restart command did not succeed.');
}

function processForService(unit) {
  const r=spawnSync('systemctl',['--user','show',unit,'-p','MainPID','--value'],{encoding:'utf8',timeout:3000});
  const pid=Number(r.stdout?.trim());
  if(r.status!==0||!Number.isSafeInteger(pid)||pid<=0)return null;
  return {pid,argv:readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0')};
}

function atomicLauncher(file,text,mode,id) {
  const tmp=file+'.console-'+id+'.tmp';
  writeFileSync(tmp,text,{mode,flag:'wx'});
  renameSync(tmp,file);
}

export async function switchRuntime({
  options,live,target,expectedHash,observedPid,probe,restart=restartUserService,
  platform=process.platform,probeAttempts=40,probeIntervalMs=500
}) {
  if(platform==='win32')return {ok:false,status:409,error:'Windows runtime switching is not configured.'};
  if(!options.serviceUnit||!live?.package_root||!live?.pid||live.pid!==observedPid) {
    return {ok:false,status:409,error:'The running process changed; refresh before selecting a target.'};
  }
  if(!target||target.current||!target.verified||target.server_sha256!==expectedHash) {
    return {ok:false,status:409,error:'The selected runtime is not an available verified target.'};
  }
  const root=path.resolve(options.platformRoot);
  const launcher=path.join(root,'bin','run-devspace');
  const previous=readFileSync(launcher,'utf8');
  const currentCli=path.join(live.package_root,'dist','cli.js');
  const nextCli=path.join(target.package_root,'dist','cli.js');
  const consoleLauncher=path.join(root,'bin','run-runtime-console');
  const consolePrevious=existsSync(consoleLauncher)?readFileSync(consoleLauncher,'utf8'):null;
  const consoleHasRuntimeFlag=consolePrevious?.includes('--runtime-package')===true;
  const currentRuntimeOccurrences=consolePrevious===null?0:consolePrevious.split(live.package_root).length-1;
  const relative=path.relative(root,target.package_root);
  if(previous.split(currentCli).length!==2||!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) {
    return {ok:false,status:409,error:'The service launcher does not match the verified live runtime.'};
  }
  if(consoleHasRuntimeFlag&&currentRuntimeOccurrences!==1) {
    return {ok:false,status:409,error:'The console launcher does not match the verified live runtime.'};
  }
  if(sha256(path.join(target.package_root,'dist','server.js'))!==expectedHash) {
    return {ok:false,status:409,error:'Selected runtime changed after the preview.'};
  }
  const folder=path.join(root,'state','runtime-rollback');
  mkdirSync(folder,{recursive:true,mode:0o700});
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex');
  const backup=path.join(folder,id+'.run-devspace.bak');
  const consoleBackup=consolePrevious===null?null:path.join(folder,id+'.run-runtime-console.bak');
  const mode=statSync(launcher).mode&0o777;
  const consoleMode=consolePrevious===null?null:(statSync(consoleLauncher).mode&0o777);
  copyFileSync(launcher,backup);
  if(consoleBackup)copyFileSync(consoleLauncher,consoleBackup);
  let changed=false;
  try{
    atomicLauncher(launcher,previous.replace(currentCli,nextCli),mode,id);
    changed=true;
    if(consolePrevious!==null&&consoleHasRuntimeFlag) {
      atomicLauncher(
        consoleLauncher,
        consolePrevious.replace(live.package_root,target.package_root),
        consoleMode,
        id+'-console'
      );
    }
    await restart(options.serviceUnit);
    let ready=false;
    for(let n=0;n<probeAttempts;n++){
      if(await probe(target)){ready=true;break;}
      await pause(probeIntervalMs);
    }
    if(!ready)throw new Error('The target failed live-process and local MCP health checks.');
    // The Console process intentionally remains independent and is not restarted
    // with the MCP runtime. Keep its in-memory configured package aligned now;
    // the persisted run-runtime-console launcher keeps the same value after a
    // later Console or machine restart.
    writeFileSync(path.join(folder,id+'.json'),JSON.stringify({
      id,target_id:target.id,version:target.version,server_sha256:expectedHash,
      previous_package_root:live.package_root,launcher_backup:backup,
      console_launcher_backup:consoleBackup,
      completed_at:new Date().toISOString()
    },null,2)+'\n',{flag:'wx',mode:0o600});
    if(options.explicitRuntimePackage)options.explicitRuntimePackage=target.package_root;
    return {ok:true,status:200,target_id:target.id,version:target.version,backup_id:id,health:'verified'};
  }catch(error){
    let restored=false;
    if(changed){
      try{
        atomicLauncher(launcher,previous,mode,id+'-restore');
        if(consolePrevious!==null&&consoleHasRuntimeFlag) {
          atomicLauncher(consoleLauncher,consolePrevious,consoleMode,id+'-console-restore');
        }
        await restart(options.serviceUnit);
        const previousTarget={package_root:live.package_root};
        for(let n=0;n<probeAttempts;n++){
          if(await probe(previousTarget)){restored=true;break;}
          await pause(probeIntervalMs);
        }
      }catch{}
    }
    return {ok:false,status:500,error:restored?'Rollback failed and the previous launcher was restored.':'Rollback failed; inspect the preserved launcher backup.',restored,backup_id:id};
  }
}

export async function localRuntimeProbe(options,target) {
  try{
    const process=processForService(options.serviceUnit);
    if(!process||!process.argv.includes(path.join(target.package_root,'dist','cli.js')))return false;
    const config=JSON.parse(readFileSync(options.configPath,'utf8'));
    const port=config?.server?.port;
    const base=new URL(config.server.publicBaseUrl);
    if(!Number.isSafeInteger(port))return false;
    const url='http://127.0.0.1:'+port+base.pathname.replace(/\/+$/,'')+'/healthz';
    const ac=new AbortController(),timeout=setTimeout(()=>ac.abort(),2000);
    try{
      const response=await fetch(url,{signal:ac.signal,redirect:'manual'});
      return response.status===200&&(await response.json()).ok===true;
    }finally{clearTimeout(timeout);}
  }catch{return false;}
}
