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
  const target=path.join(dir,name);copyFileSync(source,target);return name;
}
function listConfigHistory(options){
  const dir=configHistoryDir(options);
  try{
    return readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()&&x.name.endsWith('.json'))
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

export function managementSnapshot(options,runtime,inventory) {
  const config=readJson(options.configPath)||{};
  const projects=projectChoices(inventory?.workspaces||[]);
  return {
    settings:{
      allowed_roots:config.workspaces?.allowedRoots||[],
      local_port:config.server?.port||null,
      public_base_url:config.server?.publicBaseUrl||null,
      allowed_hosts:config.server?.allowedHosts||[],
      tunnel_mode:'Remote',
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
      next.server={...(next.server||{}),publicBaseUrl:u.href.replace(/\/$/,'')};
    }else next.server={...(next.server||{}),publicBaseUrl:null};
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
  atomicJson(options.configPath,next,0o600);
  return {ok:true,history,config:redactConfig(next)};
}

export function setTunnelToken(options,value) {
  const token=text(value).trim();
  if(token.length<20||token.length>8192||/[\r\n]/.test(token))throw new Error('Invalid Cloudflare Tunnel token.');
  const file=tokenFile(options),dir=path.dirname(file);mkdirSync(dir,{recursive:true,mode:0o700});
  const tmp=file+'.tmp-'+randomBytes(4).toString('hex');writeFileSync(tmp,token+'\n',{flag:'wx',mode:0o600});renameSync(tmp,file);
  return {ok:true,token_present:true};
}
export function setAutostart(options,enabled) {
  const action=enabled?'enable':'disable';
  const units=[options.serviceUnit,options.tunnelUnit].filter(Boolean);
  for(const unit of units){const r=service(unit,action);if(!r.ok)throw new Error('Unable to '+action+' '+unit+': '+clip(r.stderr,200));}
  return {ok:true,enabled:!!enabled};
}
export function serviceAction(options,target,action) {
  if(!['start','stop','restart'].includes(action))return {ok:false,status:400,error:'Unknown service action.'};
  const units=target==='devspace'?[options.serviceUnit]:target==='tunnel'?[options.tunnelUnit]:target==='all'?[options.serviceUnit,options.tunnelUnit]:[];
  if(!units.length||units.some(x=>!x))return {ok:false,status:404,error:'Unknown service target.'};
  for(const unit of units){const r=service(unit,action);if(!r.ok)return {ok:false,status:500,error:clip(r.stderr||('Failed to '+action+' '+unit),250)};}
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
    return {version:'V'+item.number,review_ref:item.commit,created_at:created.ok?created.stdout.trim():null,summary,is_current:item.commit===current,is_active:isActive,is_baseline:item.commit===base,rollback_steps:isActive?active.length-1-index:0,status:item.commit===current?'current':isActive?'rollback':'archived'};
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
export function observeProject(workspaces,id,summary='Manual web-console snapshot') {
  const project=resolveProject(workspaces,id);if(!project)throw new Error('Unknown project.');
  const root=repoRoot(project.root);if(!root)throw new Error('Selected workspace is not a Git repository.');
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
  updateRef(root,HEAD_REF,next,head);updateRef(root,VERSION_PREFIX+'V'+String(number).padStart(4,'0'),next);writeNote(root,next,summary);
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
  if(typeof id!=='string'||!/^20\d{2}-[A-Za-z0-9_.-]+\.json$/.test(id))throw new Error('Invalid history ID.');
  const file=path.join(configHistoryDir(options),id);
  if(!existsSync(file))throw new Error('History item not found.');
  return {id,config:redactConfig(readJson(file))};
}
export function restoreConfigHistory(options,id) {
  if(typeof id!=='string'||!/^20\d{2}-[A-Za-z0-9_.-]+\.json$/.test(id))throw new Error('Invalid history ID.');
  const file=path.join(configHistoryDir(options),id),value=readJson(file);
  if(!value||value.configVersion!==1)throw new Error('History item is invalid.');
  const previous=snapshotConfig(options,'before-history-restore');atomicJson(options.configPath,value,0o600);
  return {ok:true,previous,restored:id};
}
export function redactedConfig(options){return redactConfig(readJson(options.configPath)||{});}
export function validateManagedConfig(options,runtimePackage) {
  const config=readJson(options.configPath),errors=[],warnings=[];
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
  return {ok:errors.length===0,errors,warnings};
}
export function doctor(options,runtimePackage) {
  if(!runtimePackage)throw new Error('Running DevSpace package is unknown.');
  const cli=path.join(runtimePackage,'dist','cli.js');if(!existsSync(cli))throw new Error('DevSpace CLI is missing.');
  const configDir=path.dirname(options.configPath);
  const r=run(process.execPath,[cli,'doctor'],{env:{DEVSPACE_CONFIG_DIR:configDir},timeout:15000,maxBuffer:2*1024*1024});
  return {ok:r.ok,exit_code:r.status,output:clip((r.stdout+(r.stderr?'\n'+r.stderr:'')).trim(),30000)};
}
export function recentWorkspaceLog(unit,workspaceId,lines=250) {
  if(!unit||process.platform==='win32'||typeof workspaceId!=='string'||!/^[A-Za-z0-9._-]+$/.test(workspaceId))return '';
  const r=run('journalctl',['--user','-u',unit,'-n','5000','--no-pager','-o','cat'],{timeout:6000,maxBuffer:6*1024*1024});
  if(!r.ok)return '';
  const result=[];
  for(const line of r.stdout.split(/\r?\n/)){
    const start=line.indexOf('{');if(start<0)continue;
    try{
      const event=JSON.parse(line.slice(start));
      if(event.workspaceId!==workspaceId)continue;
      if(!['tool_call','tool_call_error','workspace_open','show_changes'].includes(event.event)&&!event.tool)continue;
      const parts=[event.ts||'',event.event||'event',event.tool||'',event.workingDirectory||'',event.success===false?'FAIL':''];
      result.push(parts.filter(Boolean).join(' | '));
      while(result.length>lines)result.shift();
    }catch{}
  }
  return result.join('\n');
}
export function recentServiceLog(unit,lines=200) {
  if(!unit||process.platform==='win32')return '';
  const r=run('journalctl',['--user','-u',unit,'-n',String(Math.min(500,Math.max(10,lines))),'--no-pager','-o','short-iso'],{timeout:5000,maxBuffer:2*1024*1024});
  return clip(r.stdout,60000);
}
