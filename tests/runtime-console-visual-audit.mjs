// Isolated headless browser acceptance: no connection to a user's open browser.
// Run with the fixture server: node tests/runtime-console-preview.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const edge=process.env.EDGE_PATH||(process.platform==='win32'?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':'/usr/bin/chromium');
if(!existsSync(edge))throw new Error('Isolated headless browser unavailable: '+edge);
const target=process.env.CONSOLE_PREVIEW_URL||'http://127.0.0.1:17689/';
const out=path.resolve('tests/.review-runtime');
mkdirSync(out,{recursive:true});
const profile=mkdtempSync(path.join(tmpdir(),'devspace-console-cdp-'));
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
const port=await freePort();
const browser=spawn(edge,[
  '--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--disable-background-networking',
  '--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'
],{stdio:'ignore',windowsHide:true});
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
let socket;
try{
  let page;
  for(let i=0;i<75;i++){
    try {const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();page=pages.find((x)=>x.type==='page');if(page)break;}catch{}
    await sleep(100);
  }
  if(!page)throw new Error('Browser debugging endpoint did not start.');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0;const waits=new Map();const exceptions=[];
  socket.addEventListener('message',(event)=>{
    const msg=JSON.parse(event.data);
    if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params?.exceptionDetails?.text||'Exception');
    if(msg.id&&waits.has(msg.id)){const entry=waits.get(msg.id);waits.delete(msg.id);msg.error?entry.reject(new Error(msg.error.message)):entry.resolve(msg.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const key=++id;waits.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));
    setTimeout(()=>{if(waits.has(key)){waits.delete(key);reject(new Error('CDP timeout: '+method));}},12000).unref?.();
  });
  const evaluate=async(expr)=>{const value=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.text);return value.result.value;};
  await send('Page.enable');await send('Runtime.enable');
  const observations=[];
  const variants=[
    {name:'desktop-zh-dark',width:1440,height:900,lang:'zh',theme:'dark',view:'overview'},
    {name:'desktop-en-light',width:1440,height:900,lang:'en',theme:'light',view:'runtime'},
    {name:'mobile-zh-dark',width:390,height:844,lang:'zh',theme:'dark',view:'overview'},
    {name:'mobile-en-light',width:390,height:844,lang:'en',theme:'light',view:'requests'},
  ];
  for(const variant of variants){
    await send('Emulation.setDeviceMetricsOverride',{width:variant.width,height:variant.height,deviceScaleFactor:1,mobile:variant.width<600});
    await send('Page.navigate',{url:target});
    let ready=false;
    for(let i=0;i<70;i++){
      ready=await evaluate("Boolean(document.querySelector('#overview-content .hero'))");
      if(ready)break;
      await sleep(100);
    }
    if(!ready)throw new Error('UI did not render '+variant.name);
    await evaluate("document.querySelector('#language').value="+JSON.stringify(variant.lang)+";document.querySelector('#language').dispatchEvent(new Event('change',{bubbles:true}));");
    await evaluate("if(document.documentElement.dataset.theme!=="+JSON.stringify(variant.theme)+")document.querySelector('#theme-toggle').click();");
    await evaluate("document.querySelector('[data-view="+JSON.stringify(variant.view)+"]').click();");
    await sleep(120);
    const report=await evaluate(`(()=>{
      const css=getComputedStyle(document.documentElement);
      const channels=(x)=>{const value=x.trim();const parts=value.startsWith('#')?(value.length===4?[1,2,3].map(i=>parseInt(value[i]+value[i],16)):[1,3,5].map(i=>parseInt(value.slice(i,i+2),16))):value.match(/\\d+(?:\\.\\d+)?/g).slice(0,3).map(Number);return parts.map(n=>{const c=n/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});};
      const lum=(x)=>{const [r,g,b]=channels(x);return .2126*r+.7152*g+.0722*b;};
      const contrast=(a,b)=>{const aa=lum(a),bb=lum(b);return (Math.max(aa,bb)+.05)/(Math.min(aa,bb)+.05);};
      const main=css.getPropertyValue('--surface').trim();
      return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,
        theme:document.documentElement.dataset.theme,language:document.documentElement.lang,
        view:document.querySelector('.view.active')?.id,heading:document.querySelector('h1')?.textContent,
        loaded:Boolean(document.querySelector('.hero,.panel')),navCount:document.querySelectorAll('.nav-item').length,
        focusable:document.querySelectorAll('button,select,input,a').length,skipLink:Boolean(document.querySelector('.skip-link')),
        textContrast:+contrast(css.getPropertyValue('--text'),main).toFixed(2),
        mutedContrast:+contrast(css.getPropertyValue('--muted'),main).toFixed(2),
        accentContrast:+contrast(css.getPropertyValue('--accent'),main).toFixed(2)};
    })()`);
    const png=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    writeFileSync(path.join(out,variant.name+'.png'),Buffer.from(png.data,'base64'));
    const pass=report.width===variant.width&&report.documentWidth<=variant.width&&report.theme===variant.theme&&report.view==='view-'+variant.view&&report.loaded&&report.navCount===6&&report.skipLink&&report.textContrast>=4.5&&report.mutedContrast>=4.5&&report.accentContrast>=4.5;
    observations.push({...variant,...report,pass});
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('#menu-toggle').click();");
  const drawer=await evaluate("({open:document.querySelector('#sidebar').classList.contains('open'),expanded:document.querySelector('#menu-toggle').getAttribute('aria-expanded'),scrim:!document.querySelector('#mobile-scrim').hidden})");
  observations.push({name:'mobile-drawer',...drawer,pass:drawer.open&&drawer.expanded==='true'&&drawer.scrim});
  await evaluate("document.querySelector('[data-view=\"activity\"]').click();");
  const navigation=await evaluate("({view:document.querySelector('.view.active')?.id,closed:!document.querySelector('#sidebar').classList.contains('open'),heading:document.querySelector('h1')?.textContent})");
  observations.push({name:'mobile-navigation',...navigation,pass:navigation.view==='view-activity'&&navigation.closed});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate("document.querySelector('#refresh').focus();");
  const focused=await evaluate("({focused:document.activeElement?.id,outline:getComputedStyle(document.activeElement).outlineStyle})");
  observations.push({name:'keyboard-focus',...focused,pass:focused.focused==='refresh'&&focused.outline!=='none'});
  // Isolated interaction states: keyboard focus, confirmation dialog, and diagnostic error.
  await evaluate("document.querySelector('#language').focus();document.querySelector('#confirm-dialog').showModal();");
  const modal=await evaluate("({open:document.querySelector('#confirm-dialog').open,focusedInside:!!document.activeElement?.closest('#confirm-dialog'),labelled:document.querySelector('#confirm-dialog').getAttribute('aria-labelledby')==='confirm-title'})");
  observations.push({name:'dialog-focus',...modal,pass:modal.open&&modal.focusedInside&&modal.labelled});
  const screenshot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
  writeFileSync(path.join(out,'dialog-focus.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate("document.querySelector('#confirm-dialog').close();const n=document.querySelector('#notice');n.hidden=false;n.textContent='Fixture error state';n.className='notice error';");
  const error=await evaluate("({visible:!document.querySelector('#notice').hidden,text:document.querySelector('#notice').textContent})");
  observations.push({name:'error-state',...error,pass:error.visible});
  const errorImage=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
  writeFileSync(path.join(out,'error-state.png'),Buffer.from(errorImage.data,'base64'));
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reduced=await evaluate("({matches:matchMedia('(prefers-reduced-motion: reduce)').matches,transition:getComputedStyle(document.querySelector('#sidebar')).transitionDuration})");
  observations.push({name:'reduced-motion',...reduced,pass:reduced.matches&&reduced.transition.split(',').every((x)=>parseFloat(x)===0)});
  const result={target,observations,browserExceptions:exceptions,passed:observations.every((x)=>x.pass)&&exceptions.length===0};
  writeFileSync(path.join(out,'browser-acceptance.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(!result.passed)process.exitCode=1;
}finally{
  try{socket?.close();}catch{}
  browser.kill();
  await sleep(250);
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
