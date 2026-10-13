#!/usr/bin/env node
// Build-time only: freeze source identity into the deployed artifact.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args=process.argv.slice(2);
const value=(key)=>{const pos=args.indexOf('--'+key);return pos>=0?args[pos+1]:'';};
const repo=resolve(value('source-root')||'.');
const output=value('output'),server=value('server-file');
if(!output||!server)throw new Error('Expected --output and --server-file.');
const git=(...cmd)=>{
  const r=spawnSync('git',['-C',repo,...cmd],{encoding:'utf8',timeout:5000});
  if(r.status!==0)throw new Error('Unable to read source identity: '+cmd.join(' '));
  return r.stdout.trim();
};
const commit=git('rev-parse','HEAD');
if(!/^[0-9a-f]{40,64}$/i.test(commit))throw new Error('Invalid commit.');
const dirty=git('status','--porcelain').length>0;
if(args.includes('--strict')&&dirty)throw new Error('Refusing dirty release provenance.');
let branch='detached';
try {branch=git('symbolic-ref','--short','-q','HEAD')||'detached';}catch{}
const digest=createHash('sha256').update(readFileSync(server)).digest('hex');
const pkg=JSON.parse(readFileSync(resolve(value('package-file')||repo+'/package.json'),'utf8'));
const entry={
  schema_version:1,git_commit:commit,git_branch:branch,source_ref:value('source-ref')||null,
  version:value('version')||pkg.version||null,artifact_id:value('artifact-id')||null,
  server_sha256:digest,source_dirty:dirty,built_at:new Date().toISOString()
};
const uiDir=value('ui-dir');
if(uiDir){
  const root=resolve(uiDir);
  const names=['runtime-console-ui.css','runtime-console-ui.html','runtime-console-ui.js'];
  const walk=(dir,relative='control-ui')=>{
    for(const item of readdirSync(dir,{withFileTypes:true})){
      const name=relative+'/'+item.name;
      const file=join(dir,item.name);
      if(!/^[A-Za-z0-9_.-]+$/.test(item.name)||item.name==='.'||item.name==='..')throw new Error('Invalid Control UI asset name: '+name);
      if(item.isDirectory())walk(file,name);
      else if(item.isFile()&&/\.(?:html|js|css|svg|png|woff2)$/.test(item.name))names.push(name);
      else if(item.isSymbolicLink())throw new Error('Symlink in Control UI assets: '+name);
      if(names.length>515)throw new Error('Too many Control UI assets.');
    }
  };
  const modern=join(root,'control-ui');
  try { if(lstatSync(modern).isDirectory())walk(modern); else throw new Error('Control UI asset root is not a directory.'); }
  catch(error){ if(error.code!=='ENOENT')throw error; }
  entry.ui_sha256=Object.fromEntries(names.sort().map((name)=>[name,createHash('sha256').update(readFileSync(join(root,...name.split('/')))).digest('hex')]));
}
mkdirSync(dirname(resolve(output)),{recursive:true});
writeFileSync(resolve(output),JSON.stringify(entry,null,2)+'\n',{mode:0o644});
console.log('provenance='+resolve(output)+' commit='+commit+' sha256='+digest);
