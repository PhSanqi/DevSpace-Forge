import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clip=(value,n=250)=>String(value||'').slice(0,n);
const run=(command,args,timeout=15000)=>{
  const r=spawnSync(command,args,{encoding:'utf8',timeout,windowsHide:true});
  return {ok:r.status===0,status:r.status??-1,stdout:r.stdout||'',stderr:r.stderr||r.error?.message||''};
};
const active=(child)=>!!child&&Number.isSafeInteger(child.pid)&&child.pid>0&&child.exitCode===null&&child.signalCode===null;
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

export function createServiceController(options,{platform=process.platform,spawnProcess=spawn,runCommand=run,createProcessJob}={}){
  const units={devspace:options.serviceUnit,tunnel:options.tunnelUnit};
  if(platform!=='win32')return {
    available:(name)=>!!units[name],autostartAvailable:true,
    state:(name)=>{
      const unit=units[name];
      if(!unit)return {status:'inactive',enabled:'disabled',pid:null};
      const status=runCommand('systemctl',['--user','is-active',unit],5000);
      const enabled=runCommand('systemctl',['--user','is-enabled',unit],5000);
      const pidResult=runCommand('systemctl',['--user','show',unit,'-p','MainPID','--value'],3000);
      const pid=Number(pidResult.stdout.trim());
      return {status:status.ok?status.stdout.trim():'inactive',enabled:enabled.ok?enabled.stdout.trim():'disabled',pid:pidResult.ok&&Number.isSafeInteger(pid)&&pid>0?pid:null};
    },
    action:async(name,action)=>runCommand('systemctl',['--user',action,units[name]],15000),
    autostart:(enabled)=>{
      for(const unit of Object.values(units).filter(Boolean)){
        const r=runCommand('systemctl',['--user',enabled?'enable':'disable',unit],15000);
        if(!r.ok)throw new Error('Unable to '+(enabled?'enable ':'disable ')+unit+': '+clip(r.stderr));
      }
      return {ok:true,enabled:!!enabled};
    },
    log:(name,lines=200)=>{
      if(!units[name])return '';
      const r=runCommand('journalctl',['--user','-u',units[name],'-n',String(Math.min(500,Math.max(10,lines))),'--no-pager','-o','short-iso'],5000);
      return clip(r.stdout,60000);
    }
  };

  const children={devspace:null,tunnel:null};
  const starting={devspace:null,tunnel:null};
  const unassigned=new Set();
  let processJob=null,processJobPromise=null,disposed=false,shuttingDown=false;
  const buffers={devspace:'',tunnel:''};
  const dropping={devspace:false,tunnel:false};
  const logDir=path.join(options.platformRoot,'logs');
  const logFile=(name)=>path.join(logDir,name==='devspace'?'node-control-devspace.log':'node-control-cloudflared.log');
  const tokenFile=options.tunnelTokenFile||path.join(options.platformRoot,'state','secrets','cloudflare-tunnel-token.txt');
  const controlSettings=options.controlSettingsFile||path.join(options.platformRoot,'state','control-settings.json');
  const quickUrl=options.quickUrlFile||path.join(options.platformRoot,'state','quick-tunnel-url.txt');
  const platformSettings=path.join(options.platformRoot,'settings.json');
  const nodeScript=(name)=>path.join(path.dirname(fileURLToPath(import.meta.url)),name);
  function tunnelProtocol(){
    let settings={};
    if(existsSync(platformSettings)){
      try{settings=JSON.parse(readFileSync(platformSettings,'utf8').replace(/^\uFEFF/,''));}
      catch(error){throw new Error('Unable to read Windows platform settings: '+clip(error.message));}
    }
    const value=String(settings?.CloudflaredProtocol??settings?.CloudflareProtocol??'auto').trim().toLowerCase();
    if(!['auto','quic','http2'].includes(value))throw new Error('CloudflaredProtocol must be auto, quic, or http2.');
    return value;
  }
  async function job(runtimePackage){
    if(disposed)throw new Error('Windows Control is shut down.');
    if(!processJobPromise)processJobPromise=(async()=>{
      const create=createProcessJob||(await import('./windows-process-job.mjs')).createWindowsProcessJob;
      return create(runtimePackage);
    })();
    try{processJob=await processJobPromise;return processJob;}
    catch(error){processJobPromise=null;throw error;}
  }
  function redact(line){
    const secrets=[];
    try{secrets.push(readFileSync(tokenFile,'utf8').trim());}catch{}
    try{secrets.push(JSON.parse(readFileSync(path.join(path.dirname(options.configPath),'auth.json'),'utf8')).ownerToken);}catch{}
    let safe=line;
    for(const secret of secrets)if(typeof secret==='string'&&secret.length>=12)safe=safe.replaceAll(secret,'[REDACTED]');
    return safe;
  }
  function append(name,line){
    const safe=redact(line);
    mkdirSync(logDir,{recursive:true});
    const file=logFile(name);
    let prior='';try{prior=readFileSync(file,'utf8');}catch{}
    writeFileSync(file,(prior+new Date().toISOString()+' '+safe+'\n').slice(-60000));
  }
  function capture(name,chunk){
    const parts=chunk.toString('utf8').split(/\r?\n/);
    for(let i=0;i<parts.length;i++){
      if(dropping[name]){
        if(i<parts.length-1)dropping[name]=false;
        continue;
      }
      buffers[name]+=parts[i];
      if(buffers[name].length>65536){buffers[name]='';dropping[name]=i===parts.length-1;continue;}
      if(i<parts.length-1){append(name,buffers[name]);buffers[name]='';}
    }
  }
  function runtime(){
    const root=path.join(options.platformRoot,'runtime');
    let slot='';try{slot=readFileSync(path.join(root,'active-slot.txt'),'utf8').trim();}catch{}
    if(slot&&(!/^[A-Za-z0-9._-]+$/.test(slot)||slot==='.'||slot==='..'))throw new Error('Invalid active Runtime slot.');
    const dir=slot?path.join(root,'slots',slot):root;
    const node=[path.join(dir,'node','node.exe'),path.join(dir,'node','bin','node.exe')].find(existsSync);
    const pkg=[path.join(dir,'devspace','node_modules','@waishnav','devspace'),path.join(dir,'node_modules','@waishnav','devspace')].find(p=>existsSync(path.join(p,'dist','cli.js')));
    if(!node||!pkg)throw new Error('Bundled Runtime Node or DevSpace CLI is missing.');
    return {node,cli:path.join(pkg,'dist','cli.js'),pkg,dir};
  }
  function available(name){
    if(!['devspace','tunnel'].includes(name))return false;
    if(active(children[name]))return true;
    try{runtime();return name==='devspace'||existsSync(path.join(options.platformRoot,'cloudflared.exe'));}
    catch{return false;}
  }
  function localPort(){
    const config=JSON.parse(readFileSync(options.configPath,'utf8').replace(/^\uFEFF/,''));
    const port=Number(config?.server?.port);
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid managed DevSpace port.');
    return port;
  }
  async function launchNow(name,mode){
    if(disposed||shuttingDown)return {ok:false,status:-1,stderr:'Windows Control is shutting down.'};
    if([...unassigned].some(active))return {ok:false,status:-1,stderr:'An unassigned process exit was not confirmed.'};
    if(active(children[name]))return {ok:true,status:0,stdout:'',stderr:''};
    const {node,cli,pkg,dir}=runtime();
    let command,args,env={...process.env};
    if(name==='devspace'){
      let configDir=path.dirname(options.configPath);
      if(mode==='Quick'){
        const prepared=runCommand(node,[nodeScript('prepare-effective-config.mjs'),'--config',options.configPath,'--auth',path.join(configDir,'auth.json'),'--control-settings',controlSettings,'--quick-url-file',quickUrl,'--output-dir',path.join(options.platformRoot,'state','effective-config')],30000);
        if(!prepared.ok)return {ok:false,status:-1,stderr:'Effective Quick config preparation failed.'};
        configDir=prepared.stdout.trim();
      }
      for(const key of Object.keys(env))if(key.toUpperCase().startsWith('DEVSPACE_'))delete env[key];
      env.DEVSPACE_CONFIG_DIR=configDir;
      env.DEVSPACE_COMPACT_RUN_ROOT=path.join(options.stateDir||path.join(options.platformRoot,'state','devspace-state'),'compact-runs');
      env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS='30';
      env.DEVSPACE_COMPACT_LOG_MAX_BYTES='2147483648';
      const toolPaths=[path.join(dir,'serena','bin'),path.join(dir,'uv')].filter(existsSync);
      if(toolPaths.length){
        const inheritedPath=Object.entries(env).find(([key])=>key.toUpperCase()==='PATH')?.[1]||'';
        for(const key of Object.keys(env))if(key.toUpperCase()==='PATH')delete env[key];
        env.PATH=[...toolPaths,inheritedPath].filter(Boolean).join(';');
      }
      command=node;args=[cli,'serve'];
    }else{
      const cloudflared=path.join(options.platformRoot,'cloudflared.exe');
      if(!existsSync(cloudflared))return {ok:false,status:-1,stderr:'cloudflared.exe is missing.'};
      let protocol;
      try{protocol=tunnelProtocol();}
      catch(error){return {ok:false,status:-1,stderr:'Invalid Windows Tunnel protocol setting: '+clip(error.message)};}
      command=node;
      args=[nodeScript('managed-cloudflared.mjs'),'--cloudflared',cloudflared,'--control-settings',controlSettings,'--quick-url-file',quickUrl,'--local-port',String(localPort()),'--protocol',protocol,'--token-file',tokenFile];
    }
    let owner;
    try{owner=await job(pkg);}catch(error){return {ok:false,status:-1,stderr:'Windows process Job creation failed: '+clip(error.message)};}
    if(shuttingDown)return {ok:false,status:-1,stderr:'Windows Control is shutting down.'};
    let child;
    try{child=spawnProcess(command,args,{cwd:options.platformRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch(error){return {ok:false,status:-1,stderr:'Managed process launch failed: '+clip(error.message)};}
    child.once('error',error=>{append(name,'Process launch failed: '+clip(error.message));});
    if(!Number.isSafeInteger(child.pid)||child.pid<1){
      try{child.kill?.();}catch{}
      return {ok:false,status:-1,stderr:'Managed process PID is unavailable; ownership refused.'};
    }
    try{owner.addPid(child.pid);}
    catch(error){
      unassigned.add(child);
      child.once('exit',()=>unassigned.delete(child));
      const killed=runCommand('taskkill',['/PID',String(child.pid),'/T','/F'],15000);
      if(!killed.ok)try{child.kill?.();}catch{}
      if(active(child)){
        let timer;
        await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>{timer=setTimeout(resolve,15000);})]);
        clearTimeout(timer);
      }
      return {ok:false,status:-1,stderr:'Windows process Job assignment failed; ownership refused: '+clip(error.message)+(active(child)?' Candidate exit was not confirmed.':'')};
    }
    children[name]=child;
    child.stdout?.on('data',chunk=>capture(name,chunk));
    child.stderr?.on('data',chunk=>capture(name,chunk));
    child.once('exit',()=>{if(buffers[name])append(name,buffers[name]);buffers[name]='';if(children[name]===child)children[name]=null;});
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>child.once('error',resolve)),wait(400)]);
    return active(child)?{ok:true,status:0,stdout:'',stderr:''}:{ok:false,status:-1,stderr:'Managed process exited during startup.'};
  }
  async function launch(name,mode){
    if(starting[name])return starting[name];
    const pending=launchNow(name,mode);
    starting[name]=pending;
    try{return await pending;}finally{if(starting[name]===pending)starting[name]=null;}
  }
  async function stop(name){
    const child=children[name];
    if(!active(child))return {ok:false,status:-1,stderr:'No live process owned by this Control server.'};
    const pid=child.pid;
    if(!Number.isSafeInteger(pid)||pid<1)return {ok:false,status:-1,stderr:'Owned process PID is unavailable.'};
    let onExit;
    const exited=new Promise(resolve=>{onExit=()=>resolve(true);child.once('exit',onExit);});
    const killed=runCommand('taskkill',['/PID',String(pid),'/T','/F'],15000);
    if(!killed.ok&&active(child)){
      child.off('exit',onExit);
      return {ok:false,status:-1,stderr:'Unable to stop owned process tree.'};
    }
    let timer;
    const confirmed=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),15000);})]);
    clearTimeout(timer);
    return confirmed?{ok:true,status:0,stdout:'',stderr:''}:{ok:false,status:-1,stderr:'Owned process exit was not confirmed.'};
  }
  return {
    available,autostartAvailable:false,
    state:(name)=>({status:active(children[name])?'active':'inactive',enabled:'disabled',pid:active(children[name])?children[name].pid:null}),
    action:async(name,action,mode)=>{
      if(action==='start')return launch(name,mode);
      if(action==='stop')return stop(name);
      if(action==='restart'){
        if(active(children[name])){const result=await stop(name);if(!result.ok)return result;}
        return launch(name,mode);
      }
      return {ok:false,status:-1,stderr:'Unknown action.'};
    },
    autostart:()=>{throw Object.assign(new Error('Autostart is unavailable on Windows Control.'),{status:409});},
    log:(name,lines=200)=>{
      let contents='';try{contents=readFileSync(logFile(name),'utf8');}catch{}
      return redact(contents.split('\n').slice(-Math.min(500,Math.max(10,lines))-1).join('\n').slice(-60000));
    },
    shutdown:async()=>{
      if(disposed)return;
      shuttingDown=true;
      try{
        await Promise.all(Object.values(starting).filter(Boolean));
        for(const name of ['tunnel','devspace'])if(active(children[name])){
          const result=await stop(name);
          if(!result.ok)throw new Error(result.stderr);
        }
        if([...unassigned].some(active))throw new Error('Unassigned process exit was not confirmed.');
        processJob?.close();
        disposed=true;
      }finally{
        if(!disposed)shuttingDown=false;
      }
    },
    forceStopOwned:()=>{
      let attempted=false;
      for(const name of ['tunnel','devspace'])if(active(children[name]))
        {attempted=true;runCommand('taskkill',['/PID',String(children[name].pid),'/T','/F'],5000);}
      return {ok:!attempted,confirmed:!attempted};
    }
  };
}
