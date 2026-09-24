import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync, renameSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE_REF='refs/devspace/control-platform/history/base';
const HEAD_REF='refs/devspace/control-platform/history/head';
const VERSION_PREFIX='refs/devspace/control-platform/versions/';
const NOTE_REF='devspace-control-platform';
const CONVERSATION_NOTE_REF='devspace-control-platform-conversation';
const text=(v)=>String(v??'');
const clip=(v,n=600)=>text(v).slice(0,n);
const readJson=(file)=>{try{return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
const hash=(v)=>createHash('sha256').update(v).digest('hex');
const hashFile=(file)=>{try{return createHash('sha256').update(readFileSync(file)).digest('hex');}catch{return null;}};
const nowId=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex');

function run(command,args,{cwd,input,env,timeout=5000,maxBuffer=5*1024*1024}={}) {
  try{
    const r=spawnSync(command,args,{cwd,input,env:{...process.env,...env},encoding:'utf8',timeout,maxBuffer,windowsHide:true});
    return {ok:r.status===0,status:r.status??-1,stdout:r.stdout||'',stderr:r.stderr||''};
  }catch(error){return {ok:false,status:-1,stdout:'',stderr:error.message};}
}
function git(cwd,args,{input,env,timeout=5000}={}){return run('git',['-C',cwd,...args],{input,env,timeout});}
function requireGit(cwd,args,options){
  const r=git(cwd,args,options);
  if(!r.ok)throw new Error(clip(r.stderr||r.stdout||('git '+args.join(' ')+' failed'),350));
  return r.stdout.trim();
}
function service(unit,action){
  if(!unit||process.platform==='win32')return {ok:false,status:-1,stdout:'',stderr:'Unavailable'};
  return run('systemctl',['--user',action,unit],{timeout:15000});
}
function serviceActive(unit){const r=service(unit,'is-active');return r.ok?r.stdout.trim():'inactive';}
function serviceEnabled(unit){const r=service(unit,'is-enabled');return r.ok?r.stdout.trim():'disabled';}
function servicePid(unit){
  const r=run('systemctl',['--user','show',unit,'-p','MainPID','--value'],{timeout:3000});
  const pid=Number(r.stdout.trim());return r.ok&&Number.isSafeInteger(pid)&&pid>0?pid:null;
}
function atomicJson(file,value,mode=0o600){
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.tmp-'+randomBytes(4).toString('hex');
  writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode});
  renameSync(tmp,file);
}
function isSafeAbsoluteDir(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.length>1024)return false;
  try{return statSync(value).isDirectory();}catch{return false;}
}
function configHistoryDir(options){return path.join(options.platformRoot,'state','config-history-web');}
function snapshotConfig(options,label='before-change'){
  const dir=configHistoryDir(options);mkdirSync(dir,{recursive:true,mode:0o700});
  const source=options.configPath;if(!existsSync(source))throw new Error('Managed DevSpace config is missing.');
  const name=new Date().toISOString().replace(/[:.]/g,'-')+'-'+label+'.json';
  const target=path.join(dir,name);copyFileSync(source,target);
  const controlTarget=target.replace(/\.json$/,'.control.json');
  const controlSource=controlSettingsFile(options);
  if(existsSync(controlSource))copyFileSync(controlSource,controlTarget);
  else atomicJson(controlTarget,defaultControlSettings(readJson(source)||{}),0o600);
  return name;
}
function listConfigHistory(options){
  const dir=configHistoryDir(options);
  try{
    return readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()&&x.name.endsWith('.json')&&!x.name.endsWith('.control.json'))
      .map(x=>{const p=path.join(dir,x.name);const s=statSync(p);return {id:x.name,created_at:s.mtime.toISOString(),bytes:s.size};})
      .sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,30);
  }catch{return [];}
}
function redactConfig(value){
  if(Array.isArray(value))return value.map(redactConfig);
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const [key,v] of Object.entries(value))out[key]=/token|secret|password|key/i.test(key)?'[REDACTED]':redactConfig(v);
  return out;
}
function tokenFile(options){return options.tunnelTokenFile||path.join(path.dirname(path.dirname(options.configPath)),'cloudflare-tunnel-token.txt');}
function controlSettingsFile(options){return options.controlSettingsFile||path.join(path.dirname(path.dirname(options.configPath)),'control-settings.json');}
function quickUrlFile(options){return options.quickUrlFile||path.join(options.platformRoot,'state','quick-tunnel-url.txt');}
function publicBasePath(value){
  try{return new URL(text(value).trim()).pathname.replace(/\/+$/,'')||'';}catch{return '';}
}
function readQuickUrl(options){
  try{
    const value=readFileSync(quickUrlFile(options),'utf8').trim();
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash?url.origin:'';
  }catch{return '';}
}
function defaultControlSettings(config){
  const remote=text(config?.server?.publicBaseUrl).trim();
  return {schema_version:1,tunnel_mode:'Remote',remote_public_base_url:remote,public_base_path:publicBasePath(remote)};
}
function loadControlSettings(options,config=readJson(options.configPath)||{}){
  const stored=readJson(controlSettingsFile(options));
  if(!stored||stored.schema_version!==1)return defaultControlSettings(config);
  const mode=stored.tunnel_mode==='Quick'?'Quick':'Remote';
  const remote=text(stored.remote_public_base_url||config?.server?.publicBaseUrl).trim();
  return {
    schema_version:1,
    tunnel_mode:mode,
    remote_public_base_url:remote,
    public_base_path:text(stored.public_base_path||publicBasePath(remote)).replace(/\/+$/,'')
  };
}
function saveControlSettings(options,value){atomicJson(controlSettingsFile(options),value,0o600);}
export function managementPublicBaseUrl(options,config=readJson(options.configPath)||{}){
  const control=loadControlSettings(options,config);
  if(control.tunnel_mode!=='Quick')return control.remote_public_base_url||text(config?.server?.publicBaseUrl).trim()||'';
  const origin=readQuickUrl(options);
  if(!origin)return '';
  const suffix=control.public_base_path&&control.public_base_path!=='/'?'/'+control.public_base_path.replace(/^\/+/,''):'';
  return origin+suffix;
}
export function managementPublicBasePath(options,config=readJson(options.configPath)||{}){
  const control=loadControlSettings(options,config);
  return control.public_base_path&&control.public_base_path!=='/'?'/'+control.public_base_path.replace(/^\/+|\/+$/g,''):'';
}

export function managementSnapshot(options,runtime,inventory) {
  const config=readJson(options.configPath)||{};
  const control=loadControlSettings(options,config);
  const quickOrigin=readQuickUrl(options);
  const effectivePublicBaseUrl=managementPublicBaseUrl(options,config);
  const projects=projectChoices(inventory?.workspaces||[]);
  return {
    settings:{
      allowed_roots:config.workspaces?.allowedRoots||[],
      local_port:config.server?.port||null,
      public_base_url:control.remote_public_base_url||null,
      effective_public_base_url:effectivePublicBaseUrl||null,
      quick_public_origin:quickOrigin||null,
      public_base_path:control.public_base_path||'',
      allowed_hosts:config.server?.allowedHosts||[],
      tunnel_mode:control.tunnel_mode,
      tunnel_token_present:existsSync(tokenFile(options)),
      auto_start:serviceEnabled(options.serviceUnit)==='enabled',
      tool_mode:config.tools?.mode||null,
      review_ui_enabled:config.ui?.enabled!==false,
      skills_enabled:config.skills?.enabled!==false,
      skill_paths:config.skills?.paths||[],
      subagents_enabled:config.subagents?.enabled===true,
      logging:{
        level:config.logging?.level||'info',format:config.logging?.format||'json',
        requests:config.logging?.requests!==false,tool_calls:config.logging?.toolCalls!==false,
        shell_commands:config.logging?.shellCommands===true
      }
    },
    services:{
      devspace:{status:serviceActive(options.serviceUnit),enabled:serviceEnabled(options.serviceUnit),pid:servicePid(options.serviceUnit)},
      tunnel:{status:serviceActive(options.tunnelUnit),enabled:serviceEnabled(options.tunnelUnit),pid:servicePid(options.tunnelUnit)}
    },
    paths:{
      config:options.configPath,
      state:config.storage?.stateDir||null,
      worktrees:config.workspaces?.worktreeRoot||null,
      agent_dir:config.skills?.agentDir||null,
      logs:path.join(options.platformRoot,'state')
    },
    config_history:listConfigHistory(options),
    projects,
    runtime_version:runtime?.actual?.version||runtime?.version||null,
  };
}

export function updateManagedConfig(options,input) {
  const current=readJson(options.configPath);
  if(!current||current.configVersion!==1)throw new Error('Unsupported managed config.');
  const next=structuredClone(current);
  const control=loadControlSettings(options,current);
  if(input.allowed_roots!==undefined){
    if(!Array.isArray(input.allowed_roots)||input.allowed_roots.length>64||input.allowed_roots.some(x=>!isSafeAbsoluteDir(x)))throw new Error('Allowed roots must be existing absolute directories.');
    next.workspaces={...(next.workspaces||{}),allowedRoots:[...new Set(input.allowed_roots.map(x=>path.resolve(x)))]};
  }
  if(input.local_port!==undefined){
    const port=Number(input.local_port);
    if(!Number.isSafeInteger(port)||port<1||port>65535||port===options.serve)throw new Error('Invalid DevSpace port.');
    next.server={...(next.server||{}),port};
  }
  if(input.public_base_url!==undefined){
    const raw=text(input.public_base_url).trim();
    if(raw){
      const u=new URL(raw);
      if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Public base URL must be an HTTPS origin/path without credentials, query or fragment.');
      control.remote_public_base_url=u.href.replace(/\/$/,'');
      control.public_base_path=publicBasePath(control.remote_public_base_url);
    }else control.remote_public_base_url='';
  }
  if(input.tunnel_mode!==undefined){
    const mode=text(input.tunnel_mode);
    if(!['Quick','Remote'].includes(mode))throw new Error('Tunnel mode must be Quick or Remote.');
    control.tunnel_mode=mode;
  }
  if(control.tunnel_mode==='Remote'&&!control.remote_public_base_url)throw new Error('Remote Tunnel requires a public base URL.');
  next.server={...(next.server||{}),publicBaseUrl:control.tunnel_mode==='Remote'?control.remote_public_base_url:null};
  if(control.remote_public_base_url){
    const hostname=new URL(control.remote_public_base_url).hostname;
    const allowed=new Set(Array.isArray(next.server.allowedHosts)?next.server.allowedHosts:[]);
    allowed.add(hostname);
    next.server.allowedHosts=[...allowed];
  }
  if(input.tool_mode!==undefined){
    const mode=text(input.tool_mode);
    if(!['codex','claude','minimal','full'].includes(mode))throw new Error('Unsupported tool mode.');
    next.tools={...(next.tools||{}),mode};
  }
  if(input.review_ui_enabled!==undefined)next.ui={...(next.ui||{}),enabled:!!input.review_ui_enabled};
  if(input.skills_enabled!==undefined)next.skills={...(next.skills||{}),enabled:!!input.skills_enabled};
  if(input.skill_paths!==undefined){
    if(!Array.isArray(input.skill_paths)||input.skill_paths.length>64||input.skill_paths.some(x=>typeof x!=='string'||x.length>1024))throw new Error('Invalid skill paths.');
    next.skills={...(next.skills||{}),paths:input.skill_paths.map(x=>x.trim()).filter(Boolean)};
  }
  if(input.logging!==undefined){
    const l=input.logging||{};
    if(l.level!==undefined&&!['silent','error','warn','info','debug'].includes(l.level))throw new Error('Invalid log level.');
    if(l.format!==undefined&&!['pretty','json'].includes(l.format))throw new Error('Invalid log format.');
    next.logging={...(next.logging||{})};
    if(l.level!==undefined)next.logging.level=l.level;
    if(l.format!==undefined)next.logging.format=l.format;
    if(l.requests!==undefined)next.logging.requests=!!l.requests;
    if(l.tool_calls!==undefined)next.logging.toolCalls=!!l.tool_calls;
    if(l.shell_commands!==undefined)next.logging.shellCommands=!!l.shell_commands;
  }
  const history=snapshotConfig(options,'save');
  saveControlSettings(options,control);
  atomicJson(options.configPath,next,0o600);
  return {ok:true,history,config:redactConfig(next),control:redactConfig(control)};
}

export function setTunnelToken(options,value) {
  const token=text(value).trim();
  if(token.length<20||token.length>8192||/[\r\n]/.test(token))throw new Error('Invalid Cloudflare Tunnel token.');
  const file=tokenFile(options),dir=path.dirname(file);mkdirSync(dir,{recursive:true,mode:0o700});
  const tmp=file+'.tmp-'+randomBytes(4).toString('hex');writeFileSync(tmp,token+'\n',{flag:'wx',mode:0o600});renameSync(tmp,file);
  return {ok:true,token_present:true};
}
export function importLegacyQuickConfigCandidate(options,legacy,runtimeVersion='') {
  if(!legacy||typeof legacy!=='object'||Number(legacy.SchemaVersion??legacy.schemaVersion)!==1)throw new Error('Legacy QuickConfig schema version is unsupported.');
  const current=managementSnapshot(options,{actual:{version:runtimeVersion}},{}).settings;
  const notes=[];
  const workspace=text(legacy.WorkspaceRoot??legacy.workspaceRoot).trim();
  const port=Number(legacy.LocalPort??legacy.localPort);
  const rawMode=text(legacy.TunnelMode??legacy.tunnelMode).trim();
  let tunnelMode='Remote';
  if(/^quick$/i.test(rawMode))tunnelMode='Quick';
  else if(/^named$/i.test(rawMode)||legacy.IsNamedTunnel===true||legacy.isNamedTunnel===true){
    tunnelMode='Remote';
    notes.push('Legacy Named Tunnel was mapped to Remote mode. Credentials-file contents are not migrated; save a protected Tunnel Token separately.');
  }else if(rawMode)notes.push('Unrecognized legacy Tunnel mode was mapped to Remote.');
  let publicBase=text(legacy.FixedHostname??legacy.fixedHostname).trim();
  if(publicBase&&!publicBase.includes('://'))publicBase='https://'+publicBase;
  if(publicBase){
    try{
      const u=new URL(publicBase);
      if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error();
      publicBase=u.href.replace(/\/$/,'');
    }catch{notes.push('Legacy hostname was invalid and was not imported.');publicBase=current.public_base_url||'';}
  }else publicBase=current.public_base_url||'';
  let toolMode=text(legacy.ToolMode??legacy.toolMode??'minimal').trim().toLowerCase();
  if(/^1\.1\./.test(runtimeVersion)&&['minimal','full'].includes(toolMode)){
    notes.push('Legacy Tool mode '+toolMode+' does not exist in DevSpace 1.1 and was mapped to claude.');
    toolMode='claude';
  }
  if(!['minimal','full','codex','claude'].includes(toolMode))throw new Error('Legacy Tool mode cannot be migrated: '+clip(toolMode,80));
  notes.push('Legacy WorkspaceRoot is loaded as an Allowed Roots entry.');
  notes.push('Owner password, auth.json and credential file contents are not imported.');
  notes.push('Subagents remain unchanged/disabled unless the current managed configuration enables them.');
  return {
    ok:true,
    settings:{
      ...current,
      allowed_roots:workspace?[workspace]:current.allowed_roots,
      local_port:Number.isSafeInteger(port)&&port>0&&port<=65535?port:7676,
      tunnel_mode:tunnelMode,
      public_base_url:publicBase,
      auto_start:!!(legacy.AutoStart??legacy.autoStart),
      tool_mode:toolMode
    },
    notes
  };
}
export function setAutostart(options,enabled) {
  const action=enabled?'enable':'disable';
  const units=[options.serviceUnit,options.tunnelUnit].filter(Boolean);
  for(const unit of units){const r=service(unit,action);if(!r.ok)throw new Error('Unable to '+action+' '+unit+': '+clip(r.stderr,200));}
  return {ok:true,enabled:!!enabled};
}
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForQuickUrl(options,timeoutMs=20000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const url=readQuickUrl(options);
    if(url)return url;
    await sleep(250);
  }
  return '';
}
function applyService(unit,action){
  const r=service(unit,action);
  return r.ok?null:clip(r.stderr||('Failed to '+action+' '+unit),250);
}
export async function serviceAction(options,target,action) {
  if(!['start','stop','restart'].includes(action))return {ok:false,status:400,error:'Unknown service action.'};
  if(!['devspace','tunnel','all'].includes(target))return {ok:false,status:404,error:'Unknown service target.'};
  if(!options.serviceUnit||(target!=='devspace'&&!options.tunnelUnit))return {ok:false,status:404,error:'Managed service is unavailable.'};
  const mode=loadControlSettings(options).tunnel_mode;
  if(mode==='Quick'){
    if(!options.tunnelUnit)return {ok:false,status:409,error:'Quick Tunnel requires a managed cloudflared service.'};
    if(target==='devspace'){
      if(action!=='stop'&&(serviceActive(options.tunnelUnit)!=='active'||!readQuickUrl(options)))
        return {ok:false,status:409,error:'Quick Tunnel must be active and have a generated public URL before DevSpace starts.'};
      const error=applyService(options.serviceUnit,action);
      return error?{ok:false,status:500,error}:{ok:true,status:200,target,action,tunnel_mode:mode};
    }
    if(target==='all'&&action==='stop'){
      let error=applyService(options.serviceUnit,'stop')||applyService(options.tunnelUnit,'stop');
      try{rmSync(quickUrlFile(options),{force:true});}catch{}
      return error?{ok:false,status:500,error}:{ok:true,status:200,target,action,tunnel_mode:mode};
    }
    if(target==='tunnel'&&action==='stop'){
      const error=applyService(options.tunnelUnit,'stop');
      try{rmSync(quickUrlFile(options),{force:true});}catch{}
      return error?{ok:false,status:500,error}:{ok:true,status:200,target,action,tunnel_mode:mode};
    }
    const tunnelAlreadyActive=serviceActive(options.tunnelUnit)==='active';
    const existingQuick=readQuickUrl(options);
    if(target==='all'&&action==='restart')applyService(options.serviceUnit,'stop');
    let quickOrigin='';
    if(action==='start'&&tunnelAlreadyActive&&existingQuick){
      quickOrigin=existingQuick;
    }else{
      try{rmSync(quickUrlFile(options),{force:true});}catch{}
      const tunnelAction=action==='restart'||tunnelAlreadyActive?'restart':'start';
      const tunnelError=applyService(options.tunnelUnit,tunnelAction);
      if(tunnelError)return {ok:false,status:500,error:tunnelError};
      quickOrigin=await waitForQuickUrl(options);
    }
    if(!quickOrigin)return {ok:false,status:504,error:'Quick Tunnel started but no trycloudflare.com URL was observed within 20 seconds.'};
    const devspaceAction=serviceActive(options.serviceUnit)==='active'?'restart':'start';
    const devspaceError=applyService(options.serviceUnit,devspaceAction);
    if(devspaceError)return {ok:false,status:500,error:devspaceError};
    return {ok:true,status:200,target,action,tunnel_mode:mode,quick_public_origin:quickOrigin};
  }
  const sequence=target==='devspace'
    ? [[options.serviceUnit,action]]
    : target==='tunnel'
      ? [[options.tunnelUnit,action]]
      : action==='stop'
        ? [[options.tunnelUnit,'stop'],[options.serviceUnit,'stop']]
        : [[options.serviceUnit,action],[options.tunnelUnit,action]];
  for(const [unit,unitAction] of sequence){
    const error=applyService(unit,unitAction);
    if(error)return {ok:false,status:500,error};
  }
  return {ok:true,status:200,target,action};
}

function workspaceRoot(row){return row?.root||row?.workspace_root||'';}
function repoRoot(workspace){
  if(!isSafeAbsoluteDir(workspace))return '';
  const r=git(workspace,['rev-parse','--show-toplevel']);return r.ok?path.resolve(r.stdout.trim()):'';
}
function projectId(root){return hash(root).slice(0,20);}
export function projectChoices(workspaces) {
  const roots=new Map();
  for(const row of workspaces||[]){
    const candidate=row?.source_root||workspaceRoot(row);
    if(!isSafeAbsoluteDir(candidate))continue;
    const root=path.resolve(candidate);
    if(roots.has(root))continue;
    roots.set(root,{id:projectId(root),name:path.basename(root),root,branch:null,head:null,dirty:null});
  }
  return [...roots.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function resolveProject(workspaces,id){
  return projectChoices(workspaces).find(x=>x.id===id)||null;
}
function gitCommit(root,ref){const r=git(root,['rev-parse','--verify',ref+'^{commit}']);return r.ok?r.stdout.trim():'';}
function parentCommit(root,commit){const r=git(root,['rev-parse',commit+'^']);return r.ok?r.stdout.trim():'';}
function versionRefs(root){
  const r=git(root,['for-each-ref','--format=%(refname)%09%(objectname)',VERSION_PREFIX]);
  if(!r.ok)return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map(line=>{
    const [ref,commit]=line.split('\t');const m=ref.match(/\/V(\d+)$/);return m?{ref,number:Number(m[1]),commit}:null;
  }).filter(Boolean).sort((a,b)=>a.number-b.number);
}
function note(root,commit){
  const r=git(root,['notes','--ref='+NOTE_REF,'show',commit]);return r.ok?clip(r.stdout.trim(),300):'';
}
function conversationNote(root,commit){
  const r=git(root,['notes','--ref='+CONVERSATION_NOTE_REF,'show',commit]);
  return r.ok?clip(r.stdout.trim(),180):'';
}
function chain(root,current,base){
  const result=[];let cursor=current;const seen=new Set();
  while(cursor&&!seen.has(cursor)){result.unshift(cursor);if(cursor===base)break;seen.add(cursor);cursor=parentCommit(root,cursor);}
  return result[0]===base?result:[];
}
function reviewHistory(root){
  const base=gitCommit(root,BASE_REF),current=gitCommit(root,HEAD_REF),refs=versionRefs(root);
  if(!base||!current||!refs.length)return {initialized:false,current_ref:null,versions:[]};
  const active=chain(root,current,base),indexes=new Map(active.map((x,i)=>[x,i]));
  const versions=refs.map(item=>{
    const index=indexes.get(item.commit),isActive=index!==undefined;
    const created=git(root,['show','-s','--format=%cI',item.commit]);
    const summary=note(root,item.commit)||(item.number===0?'Workspace initial baseline':clip(git(root,['show','-s','--format=%s',item.commit]).stdout.trim(),240));
    return {version:'V'+item.number,review_ref:item.commit,created_at:created.ok?created.stdout.trim():null,workspace_id:conversationNote(root,item.commit)||null,summary,is_current:item.commit===current,is_active:isActive,is_baseline:item.commit===base,rollback_steps:isActive?active.length-1-index:0,status:item.commit===current?'current':isActive?'rollback':'archived'};
  });
  return {initialized:true,current_ref:current,versions};
}
function recentCommits(root,limit=20){
  const r=git(root,['log','-n',String(Math.min(50,Math.max(1,limit))),'--format=%H%x09%cI%x09%s']);
  if(!r.ok)return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map(line=>{const [commit,created_at,...rest]=line.split('\t');return {commit,short_commit:commit.slice(0,10),created_at,summary:clip(rest.join('\t'),250)};});
}
export function projectDetails(workspaces,id) {
  const choice=resolveProject(workspaces,id);if(!choice)throw new Error('Unknown project.');
  const root=repoRoot(choice.root);if(!root)throw new Error('Selected workspace is not a Git repository.');
  const branch=git(root,['symbolic-ref','--quiet','--short','HEAD']);
  const head=git(root,['rev-parse','--short=10','HEAD']);
  const status=git(root,['status','--porcelain']);
  const project={id:choice.id,name:path.basename(root),root,branch:branch.ok?branch.stdout.trim():'detached',head:head.ok?head.stdout.trim():'',dirty:status.ok&&!!status.stdout.trim()};
  const count=git(root,['rev-list','--count','HEAD']);
  const subject=git(root,['log','-1','--format=%s']);
  return {project:{...project,commit_count:Number(count.stdout.trim())||0,head_summary:subject.ok?clip(subject.stdout.trim(),250):''},commits:recentCommits(root),review:reviewHistory(root)};
}
function snapshotWorkingTree(root,parent,message) {
  const temp=mkdtempSync(path.join(os.tmpdir(),'devspace-console-version-')),index=path.join(temp,'index');
  const env={GIT_INDEX_FILE:index};
  try{
    if(parent)requireGit(root,['read-tree',parent],{env});else requireGit(root,['read-tree','--empty'],{env});
    requireGit(root,['add','-A','--','.'],{env});
    const tree=requireGit(root,['write-tree'],{env});
    const args=['-c','user.name=DevSpaceControlPlatform','-c','user.email=control@local.invalid','commit-tree',tree];
    if(parent)args.push('-p',parent);args.push('-m',message);
    return requireGit(root,args);
  }finally{rmSync(temp,{recursive:true,force:true});}
}
function updateRef(root,ref,value,expected){
  const args=['update-ref',ref,value];if(expected)args.push(expected);requireGit(root,args);
}
function writeNote(root,commit,summary){
  run('git',['-C',root,'notes','--ref='+NOTE_REF,'add','-f','-m',clip(summary,240),commit],{timeout:5000});
}
function writeConversationNote(root,commit,workspaceId){
  if(typeof workspaceId!=='string'||!/^[A-Za-z0-9._-]+$/.test(workspaceId))return;
  run('git',['-C',root,'notes','--ref='+CONVERSATION_NOTE_REF,'add','-f','-m',workspaceId,commit],{timeout:5000});
}
function latestWorkspaceIdForProject(workspaces,projectRoot){
  const normalized=path.resolve(projectRoot);
  const timeValue=value=>{
    if(typeof value==='number'&&Number.isFinite(value))return value;
    const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0;
  };
  return (workspaces||[])
    .filter(row=>{
      const candidate=row?.source_root||workspaceRoot(row);
      return isSafeAbsoluteDir(candidate)&&path.resolve(candidate)===normalized&&typeof row?.id==='string';
    })
    .sort((a,b)=>timeValue(b.last_used_at)-timeValue(a.last_used_at))[0]?.id||'';
}
export function observeProject(workspaces,id,summary='Manual web-console snapshot') {
  const project=resolveProject(workspaces,id);if(!project)throw new Error('Unknown project.');
  const root=repoRoot(project.root);if(!root)throw new Error('Selected workspace is not a Git repository.');
  const workspaceId=latestWorkspaceIdForProject(workspaces,project.root);
  const head=gitCommit(root,HEAD_REF);
  if(!head){
    const parent=gitCommit(root,'HEAD');const baseline=snapshotWorkingTree(root,parent,'ControlPlatform workspace baseline');
    updateRef(root,BASE_REF,baseline);updateRef(root,HEAD_REF,baseline);updateRef(root,VERSION_PREFIX+'V0000',baseline);writeNote(root,baseline,'Workspace 初始基线');
    return {ok:true,created:true,version:'V0',review_ref:baseline};
  }
  const next=snapshotWorkingTree(root,head,'ControlPlatform web-console snapshot');
  const compare=git(root,['diff','--quiet',head,next]);
  if(compare.status===0)return {ok:true,created:false,message:'No code changes since the current review version.'};
  if(compare.status!==1)throw new Error('Unable to compare code versions.');
  const refs=versionRefs(root),number=(refs.at(-1)?.number??-1)+1;
  updateRef(root,HEAD_REF,next,head);updateRef(root,VERSION_PREFIX+'V'+String(number).padStart(4,'0'),next);writeNote(root,next,summary);writeConversationNote(root,next,workspaceId);
  return {ok:true,created:true,version:'V'+number,review_ref:next};
}
export function rollbackReview(workspaces,id,targetRef) {
  const project=resolveProject(workspaces,id);if(!project)throw new Error('Unknown project.');
  const root=repoRoot(project.root);if(!root)throw new Error('Selected workspace is not a Git repository.');
  const history=reviewHistory(root),current=history.versions.find(x=>x.is_current),target=history.versions.find(x=>x.review_ref===targetRef);
  if(!current||!target||!target.is_active||target.is_current)throw new Error('Selected review version is not a valid earlier active version.');
  const patch=git(root,['diff','--binary','--no-color',target.review_ref,current.review_ref]);
  if(!patch.ok||!patch.stdout.trim())throw new Error('Unable to generate reverse review patch.');
  const check=git(root,['apply','--check','--reverse','--whitespace=nowarn','-'],{input:patch.stdout});
  if(!check.ok)throw new Error('Current files changed after the selected version; rollback was refused to protect later edits.');
  const apply=git(root,['apply','--reverse','--whitespace=nowarn','-'],{input:patch.stdout});
  if(!apply.ok)throw new Error('Review rollback patch failed.');
  try{updateRef(root,HEAD_REF,target.review_ref,current.review_ref);}
  catch(error){git(root,['apply','--check','--whitespace=nowarn','-'],{input:patch.stdout}).ok&&git(root,['apply','--whitespace=nowarn','-'],{input:patch.stdout});throw error;}
  return {ok:true,target:target.version,review_ref:target.review_ref,rolled_back:target.rollback_steps-current.rollback_steps,message:'Rolled back to '+target.version+' without git reset --hard.'};
}

export function configHistoryItem(options,id) {
  if(typeof id!=='string'||id.endsWith('.control.json')||!/^20\d{2}-[A-Za-z0-9_.-]+\.json$/.test(id))throw new Error('Invalid history ID.');
  const file=path.join(configHistoryDir(options),id);
  if(!existsSync(file))throw new Error('History item not found.');
  const config=readJson(file);
  const controlFile=file.replace(/\.json$/,'.control.json');
  const control=existsSync(controlFile)?readJson(controlFile):defaultControlSettings(config||{});
  return {id,config:redactConfig(config),control:redactConfig(control)};
}
export function restoreConfigHistory(options,id) {
  if(typeof id!=='string'||id.endsWith('.control.json')||!/^20\d{2}-[A-Za-z0-9_.-]+\.json$/.test(id))throw new Error('Invalid history ID.');
  const file=path.join(configHistoryDir(options),id),value=readJson(file);
  if(!value||value.configVersion!==1)throw new Error('History item is invalid.');
  const controlFile=file.replace(/\.json$/,'.control.json');
  const control=existsSync(controlFile)?readJson(controlFile):defaultControlSettings(value);
  if(!control||control.schema_version!==1)throw new Error('History control settings are invalid.');
  const previous=snapshotConfig(options,'before-history-restore');
  atomicJson(options.configPath,value,0o600);
  saveControlSettings(options,control);
  return {ok:true,previous,restored:id};
}
export function redactedConfig(options){return redactConfig(readJson(options.configPath)||{});}
export function validateManagedConfig(options,runtimePackage) {
  const config=readJson(options.configPath),errors=[],warnings=[];
  const control=loadControlSettings(options,config||{});
  if(!config||config.configVersion!==1)errors.push('Managed config schema is missing or unsupported.');
  const port=Number(config?.server?.port);
  if(!Number.isSafeInteger(port)||port<1||port>65535)errors.push('server.port is invalid.');
  if(config?.server?.host!=='127.0.0.1')warnings.push('server.host is not loopback.');
  for(const root of config?.workspaces?.allowedRoots||[])if(!isSafeAbsoluteDir(root))errors.push('Allowed root is missing or invalid: '+clip(root,160));
  const publicBase=text(config?.server?.publicBaseUrl).trim();
  if(publicBase){
    try{const u=new URL(publicBase);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)errors.push('publicBaseUrl must be HTTPS without credentials/query/fragment.');}
    catch{errors.push('publicBaseUrl is invalid.');}
  }
  const toolMode=config?.tools?.mode;
  if(toolMode&&!['codex','claude','minimal','full'].includes(toolMode))errors.push('Unsupported tools.mode: '+clip(toolMode,80));
  if(runtimePackage&&!existsSync(path.join(runtimePackage,'dist','cli.js')))errors.push('Running DevSpace CLI is missing.');
  if(options.credentialFile&&existsSync(options.credentialFile)&&process.platform!=='win32'&&(statSync(options.credentialFile).mode&0o077)!==0)errors.push('Owner credential file permissions are too broad.');
  const tunnel=tokenFile(options);
  if(existsSync(tunnel)&&process.platform!=='win32'&&(statSync(tunnel).mode&0o077)!==0)errors.push('Tunnel token file permissions are too broad.');
  if(control.tunnel_mode==='Remote'){
    if(!control.remote_public_base_url)errors.push('Remote Tunnel requires a public base URL.');
    if(options.tunnelUnit&&!existsSync(tunnel))warnings.push('Remote Tunnel token has not been stored yet.');
  }else if(control.tunnel_mode==='Quick'&&!options.tunnelUnit){
    errors.push('Quick Tunnel requires a managed cloudflared service.');
  }
  return {ok:errors.length===0,errors,warnings};
}
export function doctor(options,runtimePackage) {
  if(!runtimePackage)throw new Error('Running DevSpace package is unknown.');
  const cli=path.join(runtimePackage,'dist','cli.js');if(!existsSync(cli))throw new Error('DevSpace CLI is missing.');
  let configDir=path.dirname(options.configPath);
  if(loadControlSettings(options).tunnel_mode==='Quick'){
    const effective=path.join(options.platformRoot,'state','quick-effective-config');
    if(existsSync(path.join(effective,'config.jsonc'))&&existsSync(path.join(effective,'auth.json')))configDir=effective;
  }
  const r=run(process.execPath,[cli,'doctor'],{env:{DEVSPACE_CONFIG_DIR:configDir},timeout:15000,maxBuffer:2*1024*1024});
  return {ok:r.ok,exit_code:r.status,output:clip((r.stdout+(r.stderr?'\n'+r.stderr:'')).trim(),30000)};
}
export function recentWorkspaceActivity(unit,workspaceId,lines=250) {
  if(!unit||process.platform==='win32'||typeof workspaceId!=='string'||!/^[A-Za-z0-9._-]+$/.test(workspaceId))return {log:'',latest_tool:null};
  const r=run('journalctl',['--user','-u',unit,'-n','5000','--no-pager','-o','cat'],{timeout:6000,maxBuffer:6*1024*1024});
  if(!r.ok)return {log:'',latest_tool:null};
  const result=[];
  let latestTool=null;
  for(const line of r.stdout.split(/\r?\n/)){
    const start=line.indexOf('{');if(start<0)continue;
    try{
      const event=JSON.parse(line.slice(start));
      if(event.workspaceId!==workspaceId)continue;
      if(!['tool_call','tool_call_error','workspace_open','show_changes'].includes(event.event)&&!event.tool)continue;
      if(typeof event.tool==='string'&&event.tool)latestTool=event.tool;
      const parts=[event.ts||'',event.event||'event',event.tool||'',event.workingDirectory||'',event.success===false?'FAIL':''];
      result.push(parts.filter(Boolean).join(' | '));
      while(result.length>lines)result.shift();
    }catch{}
  }
  return {log:result.join('\n'),latest_tool:latestTool};
}
export function recentWorkspaceLog(unit,workspaceId,lines=250){return recentWorkspaceActivity(unit,workspaceId,lines).log;}
export function recentServiceLog(unit,lines=200) {
  if(!unit||process.platform==='win32')return '';
  const r=run('journalctl',['--user','-u',unit,'-n',String(Math.min(500,Math.max(10,lines))),'--no-pager','-o','short-iso'],{timeout:5000,maxBuffer:2*1024*1024});
  return clip(r.stdout,60000);
}
