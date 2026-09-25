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
    {name:'desktop-zh-dark',width:1440,height:900,lang:'zh',theme:'dark',view:'services'},
    {name:'desktop-en-light',width:1440,height:900,lang:'en',theme:'light',view:'projects'},
    {name:'desktop-1024-en-dark',width:1024,height:900,lang:'en',theme:'dark',view:'overview'},
    {name:'tablet-768-zh-light',width:768,height:900,lang:'zh',theme:'light',view:'connection'},
    {name:'mobile-zh-dark',width:390,height:844,lang:'zh',theme:'dark',view:'connection'},
    {name:'mobile-en-light',width:390,height:844,lang:'en',theme:'light',view:'devspace'},
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
    const pass=report.width===variant.width&&report.documentWidth<=variant.width&&report.theme===variant.theme&&report.view==='view-'+variant.view&&report.loaded&&report.navCount===8&&report.skipLink&&report.textContrast>=4.5&&report.mutedContrast>=4.5&&report.accentContrast>=4.5;
    observations.push({...variant,...report,pass});
  }
  // Clean, comparable renders for the WebMaker Fresh-Eyes review pack.
  for(const width of [1440,1024,768,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    await send('Page.navigate',{url:target});
    for(let i=0;i<70;i++){if(await evaluate("Boolean(document.querySelector('#overview-content .hero'))"))break;await sleep(100);}
    await evaluate("document.querySelector('#language').value='zh';document.querySelector('#language').dispatchEvent(new Event('change',{bubbles:true}));");
    await evaluate("if(document.documentElement.dataset.theme!=='dark')document.querySelector('#theme-toggle').click();");
    await evaluate("document.querySelector('[data-view=\"connection\"]').click();");
    const png=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    writeFileSync(path.join(out,'clean-'+width+'.png'),Buffer.from(png.data,'base64'));
  }
  // Every destination must be usable at both breakpoints, not just the four
  // representative screenshots. Hidden old pages do not count as navigation.
  for(const width of [1440,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    await send('Page.navigate',{url:target});
    for(let i=0;i<70;i++){if(await evaluate("Boolean(document.querySelector('#overview-content .hero'))"))break;await sleep(100);}
    for(const view of ['overview','services','connection','deployment','devspace','projects','history','diagnostics']){
      await evaluate("document.querySelector('[data-view="+JSON.stringify(view)+"]').click();");
      await sleep(35);
      const report=await evaluate(`(()=>{
        const root=document.querySelector('.view.active');
        const panels=[...root.querySelectorAll('.panel')].filter(x=>x.getBoundingClientRect().height>0);
        const overlap=(a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return x.bottom>y.top+1&&y.bottom>x.top+1&&x.right>y.left+1&&y.right>x.left+1;};
        return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,view:root?.id,
          panels:panels.length,overlap:panels.some((x,i)=>panels.slice(i+1).some(y=>overlap(x,y))),
          heading:document.querySelector('#page-title')?.textContent,
          ownerCopies:root.querySelectorAll('[data-copy-owner]').length,
          serviceControls:root.querySelectorAll('[data-service-target]').length,
          rollbackControls:root.querySelectorAll('[data-action="rollback-runtime"]').length};
      })()`);
      const ownsControls=(view==='connection'?report.ownerCopies===1:report.ownerCopies===0)&&
        (view==='services'?report.serviceControls>=6:report.serviceControls===0)&&
        (view==='deployment'?report.rollbackControls===1:report.rollbackControls===0);
      observations.push({name:'full-navigation-'+width+'-'+view,...report,
        pass:report.width===width&&report.documentWidth<=width&&report.view==='view-'+view&&
          report.panels>0&&!report.overlap&&ownsControls&&!!report.heading});
    }
  }
  // Explicit connection and rollback controls are reviewed against a fixture,
  // without ever requesting or handling a real owner credential.
  await evaluate("document.querySelector('[data-view=\"services\"]').click();");
  const services=await evaluate("({view:document.querySelector('.view.active')?.id,serviceActions:document.querySelectorAll('#services-content [data-service-target]').length,duplicateOwner:!!document.querySelector('#services-content [data-copy-owner]'),duplicateUrls:!!document.querySelector('#services-content [data-copy-url]')})");
  observations.push({name:'service-controls-no-duplicate-access',...services,pass:services.view==='view-services'&&services.serviceActions>=6&&!services.duplicateOwner&&!services.duplicateUrls});
  await evaluate("document.querySelector('[data-service-target=\"all\"][data-service-action=\"stop\"]').click();");
  const serviceGuard=await evaluate("({open:document.querySelector('#confirm-dialog').open,description:document.querySelector('#confirm-description').textContent.includes('all / stop')})");
  observations.push({name:'destructive-service-action-requires-confirmation',...serviceGuard,pass:serviceGuard.open&&serviceGuard.description});
  await evaluate("document.querySelector('#confirm-dialog').close('cancel');");
  const accessImage=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
  writeFileSync(path.join(out,'connection-controls.png'),Buffer.from(accessImage.data,'base64'));
  await evaluate("document.querySelector('[data-view=\"connection\"]').click();");
  const access=await evaluate("({view:document.querySelector('.view.active')?.id,copies:document.querySelectorAll('#connection-content [data-copy-url]:not([disabled])').length,ownerButton:!!document.querySelector('#connection-content [data-copy-owner]:not([disabled])'),masked:(()=>{const s=document.querySelector('#connection-content [data-copy-owner]')?.previousElementSibling?.querySelector('.code-text')?.textContent||'';return s.length>0&&!/[A-Za-z0-9]/.test(s)})(),hasPublic:document.querySelector('#connection-content').textContent.includes('/server/mcp')})");
  observations.push({name:'single-connection-and-credential-home',...access,pass:access.view==='view-connection'&&access.copies>=2&&access.ownerButton&&access.masked&&access.hasPublic});
  const unique=await evaluate("({navigation:document.querySelectorAll('.nav-item').length,sections:document.querySelectorAll('main .view').length,ids:new Set([...document.querySelectorAll('main .view')].map(x=>x.id)).size})");
  observations.push({name:'unified-information-architecture',...unique,pass:unique.navigation===8&&unique.sections===8&&unique.ids===8});
  const connectionConfig=await evaluate("({view:document.querySelector('.view.active')?.id,roots:!!document.querySelector('#cfg-roots'),port:document.querySelector('#cfg-port')?.value,publicUrl:document.querySelector('#cfg-public')?.value,tunnelMode:document.querySelector('#cfg-tunnel-mode')?.value,modeChoices:document.querySelector('#cfg-tunnel-mode')?.options.length,autoStart:!!document.querySelector('#cfg-autostart'),tunnelToken:!!document.querySelector('#cfg-token'),legacyImport:!!document.querySelector('#legacy-config-file')&&!!document.querySelector('[data-import-legacy]'),save:!!document.querySelector('[data-save-connection]')})");
  observations.push({name:'mandatory-connection-config',...connectionConfig,pass:connectionConfig.view==='view-connection'&&connectionConfig.roots&&connectionConfig.port==='17677'&&connectionConfig.publicUrl.includes('dev.sanqi.org/server')&&connectionConfig.tunnelMode==='Remote'&&connectionConfig.modeChoices===2&&connectionConfig.autoStart&&connectionConfig.tunnelToken&&connectionConfig.legacyImport&&connectionConfig.save});
  await evaluate("document.querySelector('#cfg-tunnel-mode').value='Quick';document.querySelector('#cfg-tunnel-mode').dispatchEvent(new Event('change',{bubbles:true}));");
  const quickMode=await evaluate("({mode:document.querySelector('#cfg-tunnel-mode')?.value,publicDisabled:document.querySelector('#cfg-public')?.disabled,tokenDisabled:document.querySelector('#cfg-token')?.disabled,saveTokenDisabled:document.querySelector('[data-save-tunnel-token]')?.disabled})");
  observations.push({name:'windows-parity-quick-tunnel-selector',...quickMode,pass:quickMode.mode==='Quick'&&quickMode.publicDisabled&&quickMode.tokenDisabled&&quickMode.saveTokenDisabled});
  await evaluate("document.querySelector('#cfg-port').value='18000';");
  await evaluate("document.querySelector('[data-view=\"devspace\"]').click();");
  const devspaceConfig=await evaluate("({view:document.querySelector('.view.active')?.id,toolMode:document.querySelector('#cfg-tool-mode')?.value,review:!!document.querySelector('#cfg-review-ui'),skills:!!document.querySelector('#cfg-skills'),skillPaths:!!document.querySelector('#cfg-skill-paths'),logLevel:!!document.querySelector('#cfg-log-level'),logFormat:!!document.querySelector('#cfg-log-format'),requestLogs:!!document.querySelector('#cfg-log-requests'),toolLogs:!!document.querySelector('#cfg-log-tools'),shellLogs:!!document.querySelector('#cfg-log-shell'),save:!!document.querySelector('[data-save-devspace]')})");
  observations.push({name:'mandatory-devspace-config',...devspaceConfig,pass:devspaceConfig.view==='view-devspace'&&devspaceConfig.toolMode==='codex'&&devspaceConfig.review&&devspaceConfig.skills&&devspaceConfig.skillPaths&&devspaceConfig.logLevel&&devspaceConfig.logFormat&&devspaceConfig.requestLogs&&devspaceConfig.toolLogs&&devspaceConfig.shellLogs&&devspaceConfig.save});
  await evaluate("document.querySelector('[data-view=\"connection\"]').click();");
  const draft=await evaluate("({port:document.querySelector('#cfg-port')?.value,mode:document.querySelector('#cfg-tunnel-mode')?.value,tokenDisabled:document.querySelector('#cfg-token')?.disabled})");
  observations.push({name:'unsaved-settings-survive-navigation',...draft,pass:draft.port==='18000'&&draft.mode==='Quick'&&draft.tokenDisabled});
  await evaluate("document.querySelector('#refresh').click();");
  await sleep(150);
  const refreshedDraft=await evaluate("({port:document.querySelector('#cfg-port')?.value,mode:document.querySelector('#cfg-tunnel-mode')?.value,paused:document.querySelector('#poll-indicator').classList.contains('is-paused')})");
  observations.push({name:'manual-refresh-preserves-unsaved-form',...refreshedDraft,pass:refreshedDraft.port==='18000'&&refreshedDraft.mode==='Quick'&&refreshedDraft.paused});
  await evaluate("document.querySelector('[data-view=\"devspace\"]').click();");
  await evaluate("document.querySelector('[data-view=\"diagnostics\"]').click();");
  const diagnostics=await evaluate("({view:document.querySelector('.view.active')?.id,validate:!!document.querySelector('[data-validate-config]'),doctor:!!document.querySelector('[data-run-doctor]'),config:!!document.querySelector('[data-show-config]'),logs:document.querySelectorAll('[data-load-log]').length,conversation:!!document.querySelector('#conversation-selector'),statePaths:document.querySelector('#diagnostics-content')?.textContent.includes('devspace-state')})");
  observations.push({name:'mandatory-diagnostics-controls',...diagnostics,pass:diagnostics.view==='view-diagnostics'&&diagnostics.validate&&diagnostics.doctor&&diagnostics.config&&diagnostics.logs===2&&diagnostics.conversation&&diagnostics.statePaths});
  await evaluate("const s=document.querySelector('#conversation-selector');s.value='ws_5b9de9ee0e';s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-load-conversation]').click();");
  for(let i=0;i<30;i++){
    if(await evaluate("document.querySelector('#diagnostics-content')?.textContent.includes('exec_command')"))break;
    await sleep(100);
  }
  const latestTool=await evaluate("({latest:document.querySelector('#diagnostics-content')?.textContent.includes('最近工具: exec_command')||document.querySelector('#diagnostics-content')?.textContent.includes('Latest tool: exec_command'),log:document.querySelector('#diagnostics-content .log-box')?.textContent.includes('tool_call')})");
  observations.push({name:'windows-parity-latest-tool-and-workspace-log',...latestTool,pass:latestTool.latest&&latestTool.log});
  await evaluate("document.querySelector('[data-view=\"history\"]').click();");
  const historyList=await evaluate("({view:document.querySelector('.view.active')?.id,items:document.querySelectorAll('[data-history-id]').length})");
  observations.push({name:'mandatory-config-history-list',...historyList,pass:historyList.view==='view-history'&&historyList.items>=1});
  await evaluate("document.querySelector('[data-history-id]').click();");
  for(let i=0;i<30;i++){
    if(await evaluate("Boolean(document.querySelector('[data-load-history-form]'))"))break;
    await sleep(100);
  }
  const historyPreview=await evaluate("({preview:!!document.querySelector('#history-content .code-box'),control:document.querySelector('#history-content .code-box')?.textContent.includes('control_settings'),load:!!document.querySelector('[data-load-history-form]'),direct:!!document.querySelector('[data-restore-history]')})");
  observations.push({name:'mandatory-config-history-preview',...historyPreview,pass:historyPreview.preview&&historyPreview.control&&historyPreview.load&&historyPreview.direct});
  await evaluate("document.querySelector('[data-load-history-form]').click();");
  const loadedForm=await evaluate("({view:document.querySelector('.view.active')?.id,port:document.querySelector('#cfg-port')?.value,publicUrl:document.querySelector('#cfg-public')?.value,tunnelMode:document.querySelector('#cfg-tunnel-mode')?.value})");
  observations.push({name:'windows-style-history-load-into-form',...loadedForm,pass:loadedForm.view==='view-connection'&&loadedForm.port==='17677'&&loadedForm.publicUrl.includes('dev.sanqi.org/server')&&loadedForm.tunnelMode==='Remote'});
  await evaluate("document.querySelector('[data-view=\"devspace\"]').click();");
  const staged=await evaluate("({view:document.querySelector('.view.active')?.id,mode:document.querySelector('#cfg-tool-mode')?.value,warning:document.querySelector('#devspace-content')?.textContent.includes('historical snapshot')||document.querySelector('#devspace-content')?.textContent.includes('历史快照')})");
  observations.push({name:'history-stages-both-config-pages',...staged,pass:staged.view==='view-devspace'&&staged.mode==='minimal'&&staged.warning});
  await evaluate("document.querySelector('[data-view=\"projects\"]').click();");
  for(let i=0;i<40;i++){
    if(await evaluate("Boolean(document.querySelector('#projects-content input[name=\"review-version\"]'))"))break;
    await sleep(100);
  }
  const project=await evaluate("({view:document.querySelector('.view.active')?.id,projectSelector:!!document.querySelector('#project-selector'),gitRows:document.querySelectorAll('#projects-content table tbody tr').length,reviewChoices:document.querySelectorAll('#projects-content input[name=\"review-version\"]').length,currentDisabled:[...document.querySelectorAll('#projects-content input[name=\"review-version\"]')].some(x=>x.disabled),sourceConversation:document.querySelector('#projects-content')?.textContent.includes('ws_5b9de9ee0e'),recordButton:!!document.querySelector('[data-record-project]')})");
  observations.push({name:'mandatory-project-git-version-management',...project,pass:project.view==='view-projects'&&project.projectSelector&&project.gitRows>=2&&project.reviewChoices>=3&&project.currentDisabled&&project.sourceConversation&&project.recordButton});
  await evaluate("const x=[...document.querySelectorAll('#projects-content input[name=\"review-version\"]')].find(x=>!x.disabled);x.click();");
  const codeRollback=await evaluate("({selected:!!document.querySelector('#projects-content input[name=\"review-version\"]:checked'),enabled:!document.querySelector('[data-project-rollback]').disabled})");
  observations.push({name:'select-code-review-version',...codeRollback,pass:codeRollback.selected&&codeRollback.enabled});
  await evaluate("document.querySelector('[data-project-rollback]').click();");
  const codeConfirm=await evaluate("({open:document.querySelector('#confirm-dialog').open,title:document.querySelector('#confirm-title').textContent,typedAreaHidden:document.querySelector('#rollback-confirm-area').hidden})");
  observations.push({name:'code-rollback-confirmation',...codeConfirm,pass:codeConfirm.open&&codeConfirm.typedAreaHidden});
  await evaluate("document.querySelector('#confirm-dialog').close('cancel');");
  await evaluate("document.querySelector('[data-view=\"deployment\"]').click();document.querySelector('#rollback-target').value='runtime-local12';document.querySelector('#rollback-target').dispatchEvent(new Event('change',{bubbles:true}));");
  const rollback=await evaluate("({view:document.querySelector('.view.active')?.id,selected:document.querySelector('#rollback-target').value,preview:document.querySelector('.rollback-preview')?.textContent.includes('1.1.0-beta.4.local.12'),enabled:!document.querySelector('[data-action=\"rollback-runtime\"]').disabled,currentDisabled:document.querySelector('#rollback-target option[value=\"runtime-local13-candidate-20260924-0118\"]')?.disabled})");
  observations.push({name:'select-specific-rollback',...rollback,pass:rollback.view==='view-deployment'&&rollback.selected==='runtime-local12'&&rollback.preview&&rollback.enabled&&rollback.currentDisabled});
  const noOverlap=await evaluate(`(()=>{
    const panels=[...document.querySelectorAll('#deployment-content .panel')];
    const overlap=(a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return x.bottom>y.top&&y.bottom>x.top&&x.right>y.left&&y.right>x.left;};
    return {panels:panels.length,rollback:!!document.querySelector('#deployment-content [data-action="rollback-runtime"]'),overlap:panels.some((x,i)=>panels.slice(i+1).some(y=>overlap(x,y)))};
  })()`);
  observations.push({name:'runtime-rollback-layout-not-obstructed',...noOverlap,pass:noOverlap.panels>=5&&noOverlap.rollback&&!noOverlap.overlap});
  const rollbackImage=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
  writeFileSync(path.join(out,'rollback-selection.png'),Buffer.from(rollbackImage.data,'base64'));
  await evaluate("document.querySelector('[data-action=\"rollback-runtime\"]').click();");
  const typed=await evaluate("({open:document.querySelector('#confirm-dialog').open,disabled:document.querySelector('#confirm-submit').disabled,target:document.querySelector('#rollback-confirm-label').textContent.includes('runtime-local12')})");
  observations.push({name:'rollback-confirmation-guard',...typed,pass:typed.open&&typed.disabled&&typed.target});
  await evaluate("document.querySelector('#rollback-confirm-input').value='wrong-target';document.querySelector('#rollback-confirm-input').dispatchEvent(new Event('input',{bubbles:true}));");
  const guarded=await evaluate("document.querySelector('#confirm-submit').disabled");
  observations.push({name:'wrong-version-rejected',disabled:guarded,pass:guarded});
  await evaluate("document.querySelector('#confirm-dialog').close('cancel');");
  // Never click the final submit in this visualization-only fixture.
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('#menu-toggle').click();");
  const drawer=await evaluate("({open:document.querySelector('#sidebar').classList.contains('open'),expanded:document.querySelector('#menu-toggle').getAttribute('aria-expanded'),scrim:!document.querySelector('#mobile-scrim').hidden})");
  observations.push({name:'mobile-drawer',...drawer,pass:drawer.open&&drawer.expanded==='true'&&drawer.scrim});
  await evaluate("document.querySelector('[data-view=\"projects\"]').click();");
  const navigation=await evaluate("({view:document.querySelector('.view.active')?.id,closed:!document.querySelector('#sidebar').classList.contains('open'),heading:document.querySelector('h1')?.textContent})");
  observations.push({name:'mobile-navigation',...navigation,pass:navigation.view==='view-projects'&&navigation.closed});
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
  // A long runtime identifier must remain inside the confirmation dialog on mobile.
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Page.navigate',{url:target});
  for(let i=0;i<70;i++){if(await evaluate("Boolean(document.querySelector('#overview-content .hero'))"))break;await sleep(100);}
  await evaluate("document.querySelector('[data-view=\"projects\"]').click();");
  const longDescription=await evaluate(`(()=>{
    const dialog=document.querySelector('#confirm-dialog');
    const description=document.querySelector('#confirm-description');
    description.textContent='Runtime target: '+ 'a'.repeat(180);
    dialog.showModal();
    return {open:dialog.open,descriptionWidth:description.clientWidth,descriptionScrollWidth:description.scrollWidth,
      dialogWidth:dialog.clientWidth,dialogScrollWidth:dialog.scrollWidth,
      wrap:getComputedStyle(description).overflowWrap,
      sidebarHidden:document.querySelector('#sidebar').getBoundingClientRect().right<=0};
  })()`);
  observations.push({name:'mobile-long-confirmation-wrap',...longDescription,
    pass:longDescription.open&&longDescription.sidebarHidden&&longDescription.wrap==='anywhere'&&
      longDescription.descriptionScrollWidth<=longDescription.descriptionWidth+1&&
      longDescription.dialogScrollWidth<=longDescription.dialogWidth+1});
  const longDescriptionImage=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
  writeFileSync(path.join(out,'mobile-long-confirmation.png'),Buffer.from(longDescriptionImage.data,'base64'));
  await evaluate("document.querySelector('#confirm-dialog').close();");
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
