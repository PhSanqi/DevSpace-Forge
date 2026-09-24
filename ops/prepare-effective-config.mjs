#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv){
  const out={};
  for(let i=0;i<argv.length;i++){
    const item=argv[i];
    if(!item.startsWith('--')||!argv[i+1])throw new Error('Invalid argument: '+item);
    out[item.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=argv[++i];
  }
  return out;
}
function readJson(file){try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}}
function atomicJson(file,value){
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.tmp-'+process.pid;
  writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  renameSync(tmp,file);
}
function basePath(control){
  const raw=String(control?.public_base_path||'').trim();
  if(!raw||raw==='/')return '';
  return '/'+raw.replace(/^\/+|\/+$/g,'');
}

const args=parseArgs(process.argv.slice(2));
for(const key of ['config','auth','controlSettings','quickUrlFile','outputDir']){
  if(!args[key])throw new Error('--'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+' is required.');
}
const control=readJson(args.controlSettings);
const mode=control?.schema_version===1&&control?.tunnel_mode==='Quick'?'Quick':'Remote';
if(mode!=='Quick'){
  process.stdout.write(path.dirname(args.config)+'\n');
  process.exit(0);
}
if(!existsSync(args.config)||!existsSync(args.auth))throw new Error('Managed DevSpace config/auth is missing.');
const waitMs=Math.max(0,Math.min(60000,Number(args.waitMs??20000)||0));
const deadline=Date.now()+waitMs;
while(!existsSync(args.quickUrlFile)&&Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,250));
}
let quickOrigin='';
try{quickOrigin=readFileSync(args.quickUrlFile,'utf8').trim();}catch{}
let quickUrl;
try{
  const u=new URL(quickOrigin);
  if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.search||u.hash)throw new Error();
  quickUrl=u.origin+basePath(control);
}catch{throw new Error('Quick Tunnel public URL is unavailable or invalid.');}
const config=readJson(args.config);
if(!config||config.configVersion!==1)throw new Error('Managed DevSpace config is invalid.');
config.server={...(config.server||{}),publicBaseUrl:quickUrl};
const hostname=new URL(quickUrl).hostname;
const allowed=new Set(Array.isArray(config.server.allowedHosts)?config.server.allowedHosts:[]);
allowed.add(hostname);
config.server.allowedHosts=[...allowed];
mkdirSync(args.outputDir,{recursive:true,mode:0o700});
atomicJson(path.join(args.outputDir,'config.jsonc'),config);
copyFileSync(args.auth,path.join(args.outputDir,'auth.json'));
try{writeFileSync(path.join(args.outputDir,'.mode'),'Quick\n',{mode:0o600});}catch{}
process.stdout.write(path.resolve(args.outputDir)+'\n');
