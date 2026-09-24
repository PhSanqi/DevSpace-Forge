#!/usr/bin/env node
/**
 * Instance-scoped DevSpace management API and static console.
 * Keep it separate from the MCP/OAuth listener and the Tunnel lifecycle.
 * Never infer the running version from a mutable slot pointer or a repo HEAD.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, realpathSync, lstatSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { switchRuntime, localRuntimeProbe } from './runtime-rollback.mjs';
import {
  managementSnapshot, projectDetails, observeProject, rollbackReview,
  updateManagedConfig, setTunnelToken, setAutostart, serviceAction,
  configHistoryItem, restoreConfigHistory, redactedConfig, validateManagedConfig, doctor,
  recentWorkspaceLog, recentServiceLog
} from './control-management.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const validUnit = /^[A-Za-z0-9_.@-]+\.service$/;
const validSlot = /^[A-Za-z0-9._-]+$/;
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const readJson = (file) => { try { return parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const fileHash = (file) => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; } };
const textFile = (file) => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const clip = (value, limit=255) => String(value ?? '').slice(0, limit);

export function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error('Unexpected argument: ' + argv[i]);
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_,c) => c.toUpperCase());
    if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Missing value for ' + argv[i]);
    options[key] = argv[++i];
  }
  const root = path.resolve(options.platformRoot || process.cwd());
  const result = {
    instance: options.instance || (process.platform === 'win32' ? 'group' : 'server'),
    platformRoot: root,
    configPath: path.resolve(options.config || path.join(root, 'state', 'devspace-config', 'config.jsonc')),
    explicitRuntimePackage: options.runtimePackage ? path.resolve(options.runtimePackage) : '',
    runtimeManifest: options.runtimeManifest || '',
    controlManifest: options.controlManifest || '',
    stateDir: options.stateDir || '',
    serviceUnit: options.serviceUnit || '',
    tunnelUnit: options.tunnelUnit || '',
    tunnelMetrics: options.tunnelMetrics || '',
    allowOwnerCopy: options.allowOwnerCopy === 'true',
    credentialFile: options.credentialFile ? path.resolve(options.credentialFile) : '',
    tunnelTokenFile: options.tunnelTokenFile ? path.resolve(options.tunnelTokenFile) : '',
    pid: options.pid ? Number(options.pid) : null,
    serve: Number(options.serve || 0),
  };
  if (!Number.isSafeInteger(result.serve) || result.serve < 0 || result.serve > 65535) throw new Error('Invalid --serve port.');
  if (result.pid !== null && (!Number.isSafeInteger(result.pid) || result.pid < 1)) throw new Error('Invalid --pid.');
  for (const unit of [result.serviceUnit,result.tunnelUnit]) if (unit && !validUnit.test(unit)) throw new Error('Invalid service unit.');
  return result;
}

function run(command,args,timeout=2500,maxBuffer=3*1024*1024) {
  try {
    const r=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer,windowsHide:true});
    return r.status === 0 ? (r.stdout || '').trim() : '';
  } catch { return ''; }
}
function systemd(unit,action) {
  if (!unit || process.platform === 'win32') return '';
  return run('systemctl',['--user',action,unit]);
}
function unitJournal(unit,lines=350) {
  if (!unit || process.platform === 'win32') return '';
  return run('journalctl',['--user','-u',unit,'-n',String(lines),'--no-pager','-o','cat'],4000);
}
function readPointer(root,name) {
  const slot=textFile(path.join(root,'runtime',name));
  return validSlot.test(slot) ? slot : '';
}
function candidatePackages(root,active) {
  const runtime=path.join(root,'runtime');
  return [
    active ? path.join(runtime,'slots',active,'devspace','node_modules','@waishnav','devspace') : '',
    path.join(runtime,'devspace','node_modules','@waishnav','devspace'),
    path.join(runtime,'node_modules','@waishnav','devspace'),
  ].filter(Boolean);
}
function packageRootFromCli(cli) {
  const normalized=path.normalize(cli);
  if (path.basename(normalized) !== 'cli.js' || path.basename(path.dirname(normalized)) !== 'dist') return '';
  const pkg=path.dirname(path.dirname(normalized));
  return existsSync(path.join(pkg,'package.json')) ? pkg : '';
}
export function resolveRunningPackage(cmdline) {
  const args=Array.isArray(cmdline) ? cmdline : String(cmdline||'').split('\0');
  for(const entry of args) {
    if (!entry || !entry.replaceAll('\\','/').endsWith('/node_modules/@waishnav/devspace/dist/cli.js')) continue;
    const pkg=packageRootFromCli(entry);
    if (pkg) return pkg;
  }
  return '';
}
function mainPid(unit) {
  const value=unit&&process.platform!=='win32' ? run('systemctl',['--user','show',unit,'-p','MainPID','--value']) : '';
  const pid=Number(value);
  return Number.isSafeInteger(pid)&&pid>0 ? pid : null;
}
function runningPackage(unit,explicitPid) {
  const pid=explicitPid||mainPid(unit);
  if (!pid) return { pid:null,packageRoot:'',evidence:'process not identified' };
  try {
    let command;
    if(process.platform==='win32') {
      const result=run('powershell.exe',['-NoProfile','-Command','(Get-CimInstance Win32_Process -Filter "ProcessId = '+pid+'").CommandLine']);
      command=result ? result.match(/(?:[^\s"]+|"[^"]+")+/g)?.map((x)=>x.replace(/^"|"$/g,'')).join('\0') : '';
    }else command=readFileSync('/proc/'+pid+'/cmdline','utf8');
    const packageRoot=resolveRunningPackage(command);
    return {pid,packageRoot,evidence:packageRoot?(process.platform==='win32'?'Windows ProcessId + command line':'systemd MainPID + /proc cmdline'):'Process command line is not a DevSpace CLI'};
  }catch{return {pid,packageRoot:'',evidence:'MainPID cmdline unavailable'};}
}
function manifest(file,expectedHash) {
  const data=file&&readJson(file);
  if (!data || typeof data!=='object' || !data.git_commit) return null;
  const commit=String(data.git_commit);
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) return null;
  if (!expectedHash || !data.server_sha256 || data.server_sha256!==expectedHash) return null;
  const result={
    git_branch:clip(data.git_branch||data.source_ref||'',120)||null,
    git_commit:commit,
    artifact_id:clip(data.artifact_id||'',150)||null,
    version:clip(data.version||'',80)||null,
    server_sha256:data.server_sha256||null,
    manifest_verified:true,
  };
  return result;
}
export function runtimeInfo(options) {
  const active=readPointer(options.platformRoot,'active-slot.txt');
  const previous=readPointer(options.platformRoot,'previous-slot.txt');
  const declared=options.explicitRuntimePackage || candidatePackages(options.platformRoot,active).find((p)=>existsSync(path.join(p,'package.json'))) || '';
  const processInfo=options.processOverride||runningPackage(options.serviceUnit,options.pid);
  const actual=processInfo.packageRoot;
  const actualHash=actual?fileHash(path.join(actual,'dist','server.js')):null;
  const declaredHash=declared?fileHash(path.join(declared,'dist','server.js')):null;
  const pointerMismatch=!!actual&&!!declared&&path.resolve(actual)!==path.resolve(declared);
  const actualVersion=actual?readJson(path.join(actual,'package.json'))?.version:null;
  const declaredVersion=declared?readJson(path.join(declared,'package.json'))?.version:null;
  const runtimeManifest=options.runtimeManifest || (actual?path.join(actual,'runtime-provenance.json'):'');
  const source=manifest(runtimeManifest,actualHash);
  const controlManifest=options.controlManifest || path.join(options.platformRoot,'control-provenance.json');
  const controlHash=fileHash(path.join(options.platformRoot,'bin','runtime-console.mjs'))||fileHash(path.join(options.platformRoot,'ops','runtime-console.mjs'));
  const control=manifest(controlManifest,controlHash);
  return {
    active_slot:active||null,previous_slot:previous||null,
    version:declaredVersion||null,package_root:declared||null,server_sha256:declaredHash,
    configured:{package_root:declared||null,version:declaredVersion||null,server_sha256:declaredHash},
    actual:{pid:processInfo.pid,package_root:actual||null,version:actualVersion||null,server_sha256:actualHash,evidence:processInfo.evidence},
    pointer_mismatch:pointerMismatch,hashes_equal:!!actualHash&&actualHash===declaredHash,
    provenance:{runtime:source,control,evidence:source?.manifest_verified?'matched installed server.js SHA-256':'not recorded or not verified'},
  };
}
function deploymentInfo(options,rt) {
  let rollback=[];
  try {rollback=readdirSync(options.platformRoot,{withFileTypes:true}).filter((d)=>d.isDirectory()&&/^runtime-local\d+$/i.test(d.name)&&d.name!==rt.active_slot).map((d)=>d.name).sort();}catch{}
  if(rt.previous_slot&&!rollback.includes(rt.previous_slot))rollback.unshift(rt.previous_slot);
  const backupRoot=path.join(options.platformRoot,'state','backup');
  let backups=[];
  try {backups=readdirSync(backupRoot,{withFileTypes:true}).filter((x)=>x.isDirectory()).map((x)=>x.name).sort().reverse().slice(0,20);}catch{}
  return {active_slot:rt.active_slot,previous_slot:rt.previous_slot,runtime_root:rt.actual.package_root ? path.dirname(path.dirname(path.dirname(rt.actual.package_root))) : null,configured_runtime_root:rt.package_root ? path.dirname(path.dirname(path.dirname(rt.package_root))) : null,rollback_candidates:rollback,rollback_targets:rollbackTargets(options,rt),backup_root_present:existsSync(backupRoot),recent_backups:backups};
}

export function rollbackTargets(options,rt=runtimeInfo(options)) {
  const root=path.resolve(options.platformRoot);
  const entries=[];
  try{
    for(const entry of readdirSync(root,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^runtime-local[0-9]+(?:-[A-Za-z0-9_-]+)*$/.test(entry.name))continue;
      const dir=path.join(root,entry.name);
      const pkg=path.join(dir,'node_modules','@waishnav','devspace');
      const cli=path.join(pkg,'dist','cli.js');
      const source=path.join(pkg,'dist','server.js');
      try{
        if(realpathSync(dir)!==dir||realpathSync(pkg)!==pkg||!lstatSync(cli).isFile()||!lstatSync(source).isFile())continue;
        const version=readJson(path.join(pkg,'package.json'))?.version;
        const hash=fileHash(source);
        if(typeof version!=='string'||!hash)continue;
        entries.push({id:entry.name,version,server_sha256:hash,package_root:pkg,current:rt.actual?.package_root===pkg,verified:true});
      }catch{}
    }
  }catch{}
  return entries.sort((a,b)=>a.id.localeCompare(b.id));
}
function requestDiagnostics(unit) {
  const recent=[];
  for(const line of unitJournal(unit,700).split('\n')) {
    const start=line.indexOf('{');if(start<0)continue;
    const x=parse(line.slice(start));
    if (!x || !['http_request','http_request_aborted'].includes(x.event))continue;
    recent.push({
      ts:clip(x.ts,40),event:x.event,request_id:clip(x.requestId,100),
      cf_ray:clip(x.cfRay,100),method:clip(x.method,12),status:Number(x.status)||0,
      outcome:clip(x.outcome,60),duration_ms:Number(x.durationMs)||0,
      first_byte_ms:Number(x.firstByteMs)||0,
      tool_started:Number(x.toolStartedCount)||0,tool_resolved:Number(x.toolResolvedCount)||0,
      tool_rejected:Number(x.toolRejectedCount)||0,
      first_byte_observation:clip(x.firstByteObservation,70),
    });
  }
  const items=recent.slice(-30).reverse();
  return {available:!!unit,observation_scope:'origin HTTP; first byte is origin write, not client receipt',total_observed:recent.length,aborted_observed:recent.filter((x)=>x.event==='http_request_aborted').length,recent:items};
}
function tunnelDiagnostics(unit) {
  const events=[];
  for(const line of unitJournal(unit,450).split('\n')) {
    if(!/registered tunnel connection/i.test(line))continue;
    const index=line.match(/connIndex=(\d+)/i),protocol=line.match(/protocol=([^\s]+)/i);
    events.push({index:index?Number(index[1]):null,protocol:protocol?.[1]||null,ts:clip(line.slice(0,32),32)});
  }
  const latest=events.at(-1);
  return {actual_protocol:latest?.protocol||null,last_registered_at:latest?.ts||null,registered_connections:new Set(events.slice(-8).map((x)=>x.index).filter((x)=>x!==null)).size};
}
async function fetchHealth(url) {
  if(!url)return {ok:false,status:0,error:'No URL configured'};
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),2500),start=performance.now();
  timer.unref?.();
  try {const r=await fetch(url,{redirect:'manual',signal:ac.signal});return {ok:r.status>=200&&r.status<300,status:r.status,duration_ms:Math.round(performance.now()-start)};}
  catch(error){return {ok:false,status:0,duration_ms:Math.round(performance.now()-start),error:clip(error.message,200)};}
  finally{clearTimeout(timer);}
}
async function tunnelMetrics(url) {
  if(!url)return null;
  try {
    const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),2000);timer.unref?.();
    try{const r=await fetch(url,{signal:ac.signal});if(!r.ok)return null;const text=await r.text();const ha=text.match(/^cloudflared_tunnel_ha_connections(?:\{[^\n]*\})?\s+([0-9.]+)$/m);return {ha_connections:ha?Number(ha[1]):null};}
    finally{clearTimeout(timer);}
  }catch{return null;}
}
async function inventory(options,config,runtimePackage) {
  const result={workspace_count:0,workflow_session_count:0,job_count:0,workspaces:[],workflow_sessions:[],jobs:[],available:false,error:null};
  let openDb;
  try {
    const {DatabaseSync}=await import('node:sqlite');
    openDb=(file)=>new DatabaseSync(file,{readOnly:true});
  }catch {
    try {
      const runtimeRequire=createRequire(path.join(runtimePackage,'package.json'));
      const Database=runtimeRequire('better-sqlite3');
      openDb=(file)=>new Database(file,{readonly:true,fileMustExist:true});
    }catch {result.error='No read-only SQLite driver is available';return result;}
  }
  const state=path.resolve(options.stateDir||config?.storage?.stateDir||path.join(options.platformRoot,'state','devspace-state'));
  const sourceFile=path.join(state,'devspace.sqlite');
  try {
    if(existsSync(sourceFile)){
      const db=openDb(sourceFile);
      try{
        const has=(table)=>!!db.prepare('select 1 from sqlite_master where type = ? and name = ?').get('table',table);
        for(const [table,key,rowsKey] of [['workspace_sessions','workspace_count','workspaces'],['workflow_sessions','workflow_session_count','workflow_sessions']]){
          if(!has(table))continue;
          result[key]=db.prepare('select count(*) as total from '+table).get().total;
          const order=table==='workspace_sessions'?'last_used_at':'updated_at';
          result[rowsKey]=db.prepare('select * from '+table+' order by '+order+' desc limit 30').all().map((x)=>{
            if(table==='workspace_sessions')return {id:x.id,root:x.root||x.workspace_root,source_root:x.source_root||null,status:x.status,mode:x.mode,last_used_at:x.last_used_at};
            return {id:x.id,workspace_root:x.workspace_root,workspace_mode:x.workspace_mode,status:x.status,task_intent:clip(x.task_intent,180),updated_at:x.updated_at,review_ref:x.review_ref};
          });
        }
      }finally{db.close();}
    }
    const jobsFile=path.join(state,'jobs','jobs.sqlite');
    if(existsSync(jobsFile)){
      const db=openDb(jobsFile);
      try{
        const has=!!db.prepare('select 1 from sqlite_master where type=? and name=?').get('table','durable_jobs');
        if(has){result.job_count=db.prepare('select count(*) as total from durable_jobs').get().total;result.jobs=db.prepare('select * from durable_jobs order by created_at desc limit 30').all().map((x)=>({id:x.id,status:x.status,workspace_id:x.workspace_id,workspace_root:x.workspace_root,working_directory:x.working_directory,pid:x.pid,created_at:x.created_at,exit_code:x.exit_code,error:clip(x.error,180)}));}
      }finally{db.close();}
    }
    result.available=true;
  }catch(error){result.error=clip(error.message,250);}
  return result;
}
export async function snapshot(options) {
  const config=readJson(options.configPath)||{};
  const rt=runtimeInfo(options);
  const base=config?.server?.publicBaseUrl||'';
  let pathPart='/healthz',publicUrl='';
  try{const u=new URL(base);pathPart=u.pathname.replace(/\/+$/,'')+'/healthz';publicUrl=u.origin+pathPart;}catch{}
  const localUrl=config?.server?.host&&config?.server?.port?'http://'+config.server.host+':'+config.server.port+pathPart:'';
  const [localHealth,publicHealth,metrics,state]=await Promise.all([
    fetchHealth(localUrl),fetchHealth(publicUrl),tunnelMetrics(options.tunnelMetrics),inventory(options,config,rt.actual.package_root||rt.package_root||options.platformRoot)
  ]);
  const devspaceStatus=systemd(options.serviceUnit,'is-active')||null;
  const tunnelStatus=systemd(options.tunnelUnit,'is-active')||null;
  return {
    schema_version:2,generated_at:new Date().toISOString(),instance:options.instance,platform:process.platform,
    runtime:rt,deployment:deploymentInfo(options,rt),
    services:{devspace:devspaceStatus,tunnel:tunnelStatus},
    mcp:{public_base_url:base,local_health:localHealth,public_health:publicHealth,request_diagnostics:requestDiagnostics(options.serviceUnit)},
    connection:{
      public_base_url:base||null,
      public_mcp_url:base?base.replace(/\/+$/,'')+'/mcp':null,
      local_mcp_url:localUrl?localUrl.replace(/\/healthz$/,'/mcp'):null,
      owner_copy_available:ownerCopyEnabled(options),
    },
    tunnel:{metrics,diagnostics:tunnelDiagnostics(options.tunnelUnit)},
    inventory:state,security:{credentials_included:false,loopback_console_only:true},
    actions:{restart_devspace:!!devspaceStatus&&process.platform!=='win32',restart_tunnel:!!tunnelStatus&&process.platform!=='win32',rollback_runtime:!!devspaceStatus&&process.platform!=='win32',copy_owner_password:ownerCopyEnabled(options)},
  };
  result.management=managementSnapshot(options,rt,state);
  return result;
}

function response(res,status,body,type='application/json; charset=utf-8') {
  res.writeHead(status,{
    'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer','x-frame-options':'DENY',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}
const json=(res,status,value)=>response(res,status,JSON.stringify(value));
function readOperatorPassword(options) {
  if(!options.allowOwnerCopy||!options.credentialFile)return null;
  try {
    if(process.platform!=='win32'&&(statSync(options.credentialFile).mode&0o077)!==0)return null;
    const store=readJson(options.credentialFile);
    const password=store?.ownerToken;
    return typeof password==='string'&&password.length>=16?password:null;
  }catch{return null;}
}
function ownerCopyEnabled(options) {
  if(!options.allowOwnerCopy||!options.credentialFile||!existsSync(options.credentialFile))return false;
  try{return process.platform==='win32'||(statSync(options.credentialFile).mode&0o077)===0;}
  catch{return false;}
}
function executeService(unit) {
  if(process.platform==='win32'||!validUnit.test(unit||''))return {ok:false,status:409,error:'Action unavailable on this platform.'};
  const r=spawnSync('systemctl',['--user','restart',unit],{encoding:'utf8',timeout:15000,windowsHide:true});
  return r.status===0 ? {ok:true,status:200,unit} : {ok:false,status:500,error:clip(r.stderr||r.error?.message||'Service restart failed',350)};
}
export function createConsoleServer(options,services={}) {
  const token=randomBytes(32).toString('base64url');
  const getSnapshot=services.snapshot||snapshot;
  const restart=services.restart||executeService;
  const getOperatorPassword=services.getOperatorPassword||readOperatorPassword;
  const changeRuntime=services.switchRuntime||switchRuntime;
  const getProjectDetails=services.projectDetails||projectDetails;
  const getConfigHistoryItem=services.configHistoryItem||configHistoryItem;
  let switching=false;
  const staticFiles={'/':'runtime-console-ui.html','/index.html':'runtime-console-ui.html','/ui.css':'runtime-console-ui.css','/ui.js':'runtime-console-ui.js'};
  const type={'/':'text/html; charset=utf-8','/index.html':'text/html; charset=utf-8','/ui.css':'text/css; charset=utf-8','/ui.js':'text/javascript; charset=utf-8'};
  const readBody=async(req,limit=32768)=>{
    let body='';
    for await(const chunk of req){body+=chunk;if(body.length>limit)throw Object.assign(new Error('Request too large.'),{status:413});}
    const value=body?parse(body):{};
    if(value===null)throw Object.assign(new Error('Invalid JSON body.'),{status:400});
    return value;
  };
  const protectedRequest=(req,host)=>req.headers.origin==='http://'+host&&req.headers['x-devspace-console-token']===token;
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host||'';
    const port=server.address()?.port||options.serve;
    const validHost=host==='127.0.0.1:'+port||host==='localhost:'+port||host==='[::1]:'+port;
    if(!validHost)return json(res,403,{error:'Loopback Host required.'});
    const requestUrl=new URL(req.url||'/','http://'+host);
    const url=requestUrl.pathname;
    if(req.method==='GET'&&Object.hasOwn(staticFiles,url)){
      try{return response(res,200,readFileSync(path.join(here,staticFiles[url])),type[url]);}
      catch{return json(res,500,{error:'Console asset unavailable.'});}
    }
    if(req.method==='GET'&&url==='/api/status'){
      try{return json(res,200,await getSnapshot(options));}
      catch(error){return json(res,500,{error:clip(error.message,200)});}
    }
    if(req.method==='GET'&&url==='/api/action-token')return json(res,200,{token});
    if(req.method==='GET'&&url==='/api/management/project'){
      try{
        const state=await getSnapshot(options);
        return json(res,200,getProjectDetails(state.inventory?.workspaces||[],requestUrl.searchParams.get('project_id')||''));
      }catch(error){return json(res,404,{error:clip(error.message,220)});}
    }
    if(req.method==='GET'&&url==='/api/management/history'){
      try{return json(res,200,getConfigHistoryItem(options,requestUrl.searchParams.get('history_id')||''));}
      catch(error){return json(res,404,{error:clip(error.message,220)});}
    }
    if(req.method==='GET'&&url==='/api/management/config')return json(res,200,{config:redactedConfig(options)});
    if(req.method==='GET'&&url==='/api/management/log'){
      const service=requestUrl.searchParams.get('service');
      const unit=service==='devspace'?options.serviceUnit:service==='tunnel'?options.tunnelUnit:'';
      if(!unit)return json(res,404,{error:'Unknown service.'});
      return json(res,200,{service,log:recentServiceLog(unit,200)});
    }
    if(req.method==='GET'&&url==='/api/management/conversation'){
      const workspaceId=requestUrl.searchParams.get('workspace_id')||'';
      try{
        const state=await getSnapshot(options);
        if(!(state.inventory?.workspaces||[]).some(x=>x.id===workspaceId))return json(res,404,{error:'Unknown workspace session.'});
        return json(res,200,{workspace_id:workspaceId,log:recentWorkspaceLog(options.serviceUnit,workspaceId,250)});
      }catch(error){return json(res,500,{error:clip(error.message,220)});}
    }
    if(req.method==='POST'&&url==='/api/credentials/owner'){
      if(req.headers.origin!=='http://'+host||req.headers['x-devspace-console-token']!==token)return json(res,403,{error:'Operator confirmation required.'});
      if(!options.allowOwnerCopy)return json(res,404,{error:'Owner password copy is disabled.'});
      if(Number(req.headers['content-length']||0)>128)return json(res,413,{error:'Request too large.'});
      const password=getOperatorPassword(options);
      if(!password)return json(res,404,{error:'Owner password copy is not available on this instance.'});
      return json(res,200,{password});
    }
    if(req.method==='POST'&&url.startsWith('/api/management/')){
      if(!protectedRequest(req,host))return json(res,403,{ok:false,error:'Same-origin operator token required.'});
      try{
        const body=await readBody(req);
        if(url==='/api/management/config/save')return json(res,200,updateManagedConfig(options,body));
        if(url==='/api/management/config/restore')return json(res,200,restoreConfigHistory(options,body.history_id));
        if(url==='/api/management/tunnel-token'){
          const result=setTunnelToken(options,body.token);
          return json(res,200,{...result,restart_required:true});
        }
        if(url==='/api/management/autostart')return json(res,200,setAutostart(options,!!body.enabled));
        if(url==='/api/management/service'){
          const result=serviceAction(options,body.target,body.action);
          return json(res,result.status||200,result);
        }
        if(url==='/api/management/doctor'){
          const info=runtimeInfo(options);return json(res,200,doctor(options,info.actual.package_root||info.package_root));
        }
        if(url==='/api/management/validate'){
          const info=runtimeInfo(options);const result=validateManagedConfig(options,info.actual.package_root||info.package_root);
          return json(res,result.ok?200:409,result);
        }
        if(url==='/api/management/project/observe'){
          const state=await getSnapshot(options);return json(res,200,observeProject(state.inventory?.workspaces||[],body.project_id,clip(body.summary||'Manual web-console snapshot',240)));
        }
        if(url==='/api/management/project/rollback'){
          const state=await getSnapshot(options);
          const result=rollbackReview(state.inventory?.workspaces||[],body.project_id,body.review_ref);
          return json(res,200,{...result,restart_required:true});
        }
        return json(res,404,{ok:false,error:'Unknown management action.'});
      }catch(error){return json(res,error.status||409,{ok:false,error:clip(error.message,300)});}
    }
    if(req.method==='POST'&&url.startsWith('/api/actions/')){
      const origin=req.headers.origin;
      if(origin!=='http://'+host)return json(res,403,{ok:false,error:'Invalid origin.'});
      if(req.headers['x-devspace-console-token']!==token)return json(res,403,{ok:false,error:'Invalid action token.'});
      if(Number(req.headers['content-length']||0)>4096)return json(res,413,{ok:false,error:'Request too large.'});
      const name=url.slice('/api/actions/'.length);
      if(name==='rollback-runtime'){
        if(req.headers.origin!=='http://'+host)return json(res,403,{ok:false,error:'Same-origin confirmation required.'});
        if(switching)return json(res,409,{ok:false,error:'A runtime switch is already in progress.'});
        switching=true;
        try {
          let body='';
          for await(const chunk of req){body+=chunk;if(body.length>4096)return json(res,413,{ok:false,error:'Request too large.'});}
          const request=parse(body);
          const info=runtimeInfo(options);
          const target=rollbackTargets(options,info).find(x=>x.id===request?.target_id);
          if(!target||target.current||target.server_sha256!==request?.expected_sha256||info.actual.pid!==request?.observed_pid)
            return json(res,409,{ok:false,error:'The selected runtime is no longer valid. Refresh and try again.'});
          const result=await changeRuntime({
            options,live:info.actual,target,expectedHash:request?.expected_sha256,
            observedPid:request?.observed_pid,
            probe:(candidate)=>localRuntimeProbe(options,candidate),
          });
          return json(res,result.status,result);
        }catch{return json(res,500,{ok:false,error:'Runtime operation failed; inspect the local console journal.'});}
        finally{switching=false;}
      }
      const unit=name==='restart-devspace'?options.serviceUnit:name==='restart-tunnel'?options.tunnelUnit:'';
      if(!unit)return json(res,404,{ok:false,error:'Unknown or disabled action.'});
      const result=restart(unit);
      return json(res,result.status,result);
    }
    return json(res,404,{error:'Not found.'});
  });
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const options=parseOptions(process.argv.slice(2));
  if(options.serve){
    const server=createConsoleServer(options);
    server.listen(options.serve,'127.0.0.1',()=>process.stdout.write('runtime-console=http://127.0.0.1:'+options.serve+'/\n'));
  } else {
    process.stdout.write(JSON.stringify(await snapshot(options),null,2)+'\n');
  }
}
