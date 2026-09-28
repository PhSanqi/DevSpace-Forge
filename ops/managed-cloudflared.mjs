#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
function modeFrom(file){
  const value=readJson(file);
  return value?.schema_version===1&&value?.tunnel_mode==='Quick'?'Quick':'Remote';
}
function atomicText(file,value){
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.tmp-'+process.pid;
  writeFileSync(tmp,value+'\n',{mode:0o600});
  renameSync(tmp,file);
}

const quickPattern=/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
export function quickTunnelOriginFromText(value){
  const match=String(value||'').match(quickPattern);
  if(!match)return '';
  try{return new URL(match[0]).origin;}catch{return '';}
}
export function buildCloudflaredArgs({mode,port,protocol='auto',tokenFile='',metrics=''}) {
  const normalized=String(protocol||'auto').toLowerCase();
  if(!['auto','quic','http2'].includes(normalized))throw new Error('Invalid --protocol.');
  if(!Number.isSafeInteger(Number(port))||Number(port)<1||Number(port)>65535)throw new Error('Invalid --local-port.');
  const args=['tunnel'];
  if(normalized!=='auto')args.push('--protocol',normalized);
  args.push('--no-autoupdate','--loglevel','info');
  if(metrics)args.push('--metrics',metrics);
  if(mode==='Quick')args.push('--url','http://127.0.0.1:'+Number(port));
  else{
    if(!tokenFile||!existsSync(tokenFile))throw new Error('Remote Tunnel token file is missing.');
    args.push('run','--token-file',tokenFile);
  }
  return args;
}

export async function main(argv=process.argv.slice(2)){
  const args=parseArgs(argv);
  if(!args.cloudflared||!existsSync(args.cloudflared))throw new Error('cloudflared binary is missing.');
  if(!args.controlSettings)throw new Error('--control-settings is required.');
  if(!args.quickUrlFile)throw new Error('--quick-url-file is required.');
  const port=Number(args.localPort);
  const mode=modeFrom(args.controlSettings);
  try{rmSync(args.quickUrlFile,{force:true});}catch{}
  const childArgs=buildCloudflaredArgs({mode,port,protocol:args.protocol,tokenFile:args.tokenFile,metrics:args.metrics});
  const child=spawn(args.cloudflared,childArgs,{stdio:['ignore','pipe','pipe']});
  let lineBuffer='';
  function observe(chunk){
    if(mode!=='Quick')return;
    lineBuffer=(lineBuffer+chunk).slice(-32768);
    const origin=quickTunnelOriginFromText(lineBuffer);
    if(origin){
      try{atomicText(args.quickUrlFile,origin);}catch{}
      lineBuffer='';
    }
  }
  child.stdout.on('data',chunk=>{process.stdout.write(chunk);observe(chunk.toString('utf8'));});
  child.stderr.on('data',chunk=>{process.stderr.write(chunk);observe(chunk.toString('utf8'));});
  for(const signal of ['SIGTERM','SIGINT']){
    process.on(signal,()=>{try{child.kill(signal);}catch{}});
  }
  return await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal)process.stderr.write('managed-cloudflared: child exited via '+signal+'\n');
      resolve(code??1);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{process.exitCode=await main();}
  catch(error){process.stderr.write('managed-cloudflared: '+error.message+'\n');process.exitCode=1;}
}
