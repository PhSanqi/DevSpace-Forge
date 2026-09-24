/* DevSpace Control Console. All runtime values are untrusted diagnostics. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const views = ['overview', 'access', 'runtime', 'connectivity', 'requests', 'activity', 'deployment'];
  const labels = {
    en: {
      workspace:'WORKSPACE',overview:'Overview',access:'Connection & access',runtime:'Runtime & versions',connectivity:'Connectivity',requests:'MCP diagnostics',activity:'Workspaces & jobs',deployment:'Deployment',loopback:'Local management interface',
      live:'Live',offline:'Unavailable',refresh:'Refresh',commandCenter:'OPERATIONS / COMMAND CENTER',noCredentials:'Credentials are never shown in this console.',cancel:'Cancel',confirm:'Confirm',protectedAction:'PROTECTED ACTION',
      overviewDesc:'Service health and verified runtime provenance.',runtimeDesc:'Distinguish package labels, Git source, and the process actually running.',connectivityDesc:'Local origin, public route, and dedicated tunnel health.',requestsDesc:'Bounded origin-side request observations. Origin response is not proof of client receipt.',activityDesc:'Durable workspaces, workflow sessions, and jobs.',deploymentDesc:'Active deployment evidence, backups, and protected operations.',
      instance:'Instance',healthy:'Operational',degraded:'Needs attention',unknown:'Unknown',health:'Health',runtimeVersion:'Runtime version',sourceRevision:'Source revision',noProvenance:'Not recorded in deployed artifact',activeWorkspaces:'Workspaces',jobs:'Durable jobs',sessions:'Workflow sessions',serviceHealth:'Service readiness',recentRequests:'Recent requests',seeAll:'See all',runtimeInfo:'Runtime identification',sourceInfo:'Build provenance',declared:'Configured package / slot',actual:'Running process',source:'Source of truth',pid:'Process ID',packageRoot:'Package root',version:'Package version',serverHash:'server.js SHA-256',gitBranch:'Git branch',gitCommit:'Git commit',controlVersion:'Control Platform version',artifact:'Artifact ID',origin:'Origin',evidence:'Evidence',notKnown:'Not verified',pointerMismatch:'The configured package path differs from the live process. Both are displayed; the configured pointer is not treated as running provenance.',hashMatch:'File bytes agree, but package paths differ.',healthLocal:'Local MCP',healthPublic:'Public MCP',tunnelService:'Tunnel service',devspaceService:'DevSpace service',tunnelConnections:'Tunnel HA links',protocol:'Transport protocol',lastReconnect:'Last connection event',transport:'Transport status',requestCount:'Observed requests',aborted:'Aborted',status:'Status',time:'Time',duration:'Duration',requestId:'Request ID',cfRay:'Cloudflare Ray',outcome:'Outcome',scope:'Observation scope',noRequests:'No request records were observed in the available log window.',filter:'Filter rows…',workspaceId:'Workspace ID',path:'Path',lastUsed:'Last used',jobId:'Job ID',command:'Command',workflowId:'Workflow ID',mode:'Mode',noRows:'No records in this window.',inventoryUnavailable:'Durable state could not be inspected.',activeSlot:'Configured active slot',previousSlot:'Previous slot',rollback:'Rollback candidates',backups:'Recent backups',deploymentRoot:'Deployment root',protectedOps:'Protected operations',protectedDesc:'These actions affect the live instance. They require an explicit confirmation and never modify the global proxy.',restartDevspace:'Restart DevSpace',restartTunnel:'Restart tunnel',confirmTitle:'Confirm service restart',confirmDesc:'This will briefly interrupt active connections. The action only targets the named service.',actionDone:'Action submitted. Check health and request diagnostics before proceeding.',actionFailed:'Action failed',fetchFailed:'Unable to fetch current diagnostics.',copy:'Copy',copied:'Copied',of:'of',noManifest:'No verified release manifest was installed; a package version alone is not a Git commit.',controlsUnavailable:'Action is not enabled for this instance.',haPartial:'Fewer than four HA connections are reported.',observed:'Observed at origin',requestsNoClient:'A successful origin write does not prove the connector received the response.',provenance:'Provenance',release:'Release',warnings:'Warnings',none:'None recorded',updated:'Updated',services:'Services'
    },
    zh: {
      workspace:'工作区',overview:'总览',access:'连接与密钥',runtime:'运行版本',connectivity:'连接与 Tunnel',requests:'MCP 诊断',activity:'工作区与任务',deployment:'部署与回滚',loopback:'仅本机访问的管理面',
      live:'实时',offline:'不可用',refresh:'刷新',commandCenter:'运维 / 控制中心',noCredentials:'此页面不会展示访问凭据。',cancel:'取消',confirm:'确认操作',protectedAction:'受保护操作',
      overviewDesc:'实例服务健康与经过验证的运行版本来源。',runtimeDesc:'明确区分包版本、Git 来源以及实际运行的进程。',connectivityDesc:'本地服务、公网入口与专属 Tunnel 连接状态。',requestsDesc:'有限窗口内的 origin 侧请求观测；origin 发出响应不代表客户端已收到。',activityDesc:'持久化工作区、流程会话与任务。',deploymentDesc:'当前部署、备份与受保护操作。',
      instance:'实例',healthy:'运行正常',degraded:'需要关注',unknown:'未知',health:'健康状态',runtimeVersion:'Runtime 版本',sourceRevision:'源码提交',noProvenance:'部署包未记录',activeWorkspaces:'工作区',jobs:'持久任务',sessions:'流程会话',serviceHealth:'服务就绪状态',recentRequests:'最近请求',seeAll:'查看全部',runtimeInfo:'运行实例身份',sourceInfo:'构建来源',declared:'配置指针 / 版本槽',actual:'真实运行进程',source:'证据来源',pid:'进程 ID',packageRoot:'程序目录',version:'包版本',serverHash:'server.js SHA-256',gitBranch:'Git 分支',gitCommit:'Git 提交',controlVersion:'Control Platform 版本',artifact:'产物标识',origin:'来源',evidence:'核验信息',notKnown:'未验证',pointerMismatch:'配置的包目录与真实进程目录不一致。两者分别展示，不再把配置指针冒充为实际运行版本。',hashMatch:'文件内容一致，但两个包目录不同。',healthLocal:'本地 MCP',healthPublic:'公网 MCP',tunnelService:'Tunnel 服务',devspaceService:'DevSpace 服务',tunnelConnections:'Tunnel HA 连接',protocol:'传输协议',lastReconnect:'最近连接事件',transport:'传输状态',requestCount:'观测请求数',aborted:'异常中断',status:'状态',time:'时间',duration:'耗时',requestId:'请求 ID',cfRay:'Cloudflare Ray',outcome:'结果',scope:'观测范围',noRequests:'当前日志窗口内没有请求记录。',filter:'筛选记录…',workspaceId:'工作区 ID',path:'路径',lastUsed:'最近使用',jobId:'任务 ID',command:'命令',workflowId:'流程 ID',mode:'模式',noRows:'当前窗口没有记录。',inventoryUnavailable:'无法读取持久状态。',activeSlot:'配置的活跃槽位',previousSlot:'上一槽位',rollback:'可回滚版本',backups:'最近备份',deploymentRoot:'部署目录',protectedOps:'受保护操作',protectedDesc:'这些操作会影响当前服务；执行前必须确认，不会修改全局代理。',restartDevspace:'重启 DevSpace',restartTunnel:'重启 Tunnel',confirmTitle:'确认重启服务',confirmDesc:'这会短暂中断现有连接，且只操作指定服务。',actionDone:'操作已提交，请核对健康状态与请求诊断。',actionFailed:'操作失败',fetchFailed:'无法取得最新诊断数据。',copy:'复制',copied:'已复制',of:'共',noManifest:'没有已核验的发行元数据；包版本不等于 Git 提交。',controlsUnavailable:'当前实例未启用该操作。',haPartial:'报告的 HA 连接少于四条。',observed:'Origin 侧观测',requestsNoClient:'origin 写入成功不能证明 connector 已收到响应。',provenance:'版本来源',release:'发行版本',warnings:'告警',none:'无记录',updated:'更新时间',services:'服务'
    }
  };
  Object.assign(labels.en,{
    accessDesc:'Copy the connection URL or explicitly request an operator credential.',
    noCredentials:'Secrets are excluded from routine diagnostics.',
    publicMcpUrl:'Public MCP endpoint',publicBaseUrl:'Public origin',localMcpUrl:'Local MCP endpoint',
    connectionDetails:'Connection details',copyUrl:'Copy URL',ownerPassword:'Owner Password',
    copyOwner:'Copy Owner Password',ownerCopyUnavailable:'Owner credential copy is not enabled on this instance.',
    ownerCopyWarning:'The credential will be copied directly to your clipboard. Never paste it into chat, logs or screenshots.',
    ownerCopyTitle:'Copy the Owner Password?',ownerCopied:'Owner Password copied. Keep it in your password manager.',
    clipboardUnavailable:'Clipboard access failed. Use a secure local terminal instead.',
    selectTarget:'Select a runtime version',runRollback:'Rollback to selected version',
    rollbackSummary:'Rollback preview',currentRuntime:'Currently running',rollbackNotAvailable:'No verified alternative runtime is available.',
    rollbackConfirmTitle:'Switch the live runtime?',rollbackConfirmText:'This will restart the MCP service, temporarily interrupt active connections, and preserve the current launcher for recovery. Tunnel and credentials will not be changed.',
    rollbackType:'Type the selected target ID to confirm:',rollbackPassed:'Target verified and active. Recheck the connector after the restart.',
    rollbackFailed:'Runtime switch was not completed.',rollbackBusy:'The service operation is running. Do not close the page.',
    rollbackSha:'Build SHA-256',rollbackStatus:'Selection status',notCurrent:'Available rollback target',
    access:'Connection & access',accessDesc:'Copy the endpoint and retrieve the owner credential through an explicit local-only action.',
  });
  Object.assign(labels.zh,{
    accessDesc:'复制连接地址，并通过单独确认的操作获取 Owner Password。',
    noCredentials:'常规诊断接口不包含密钥。',
    publicMcpUrl:'公网 MCP 连接地址',publicBaseUrl:'公网入口',localMcpUrl:'本机 MCP 地址',
    connectionDetails:'连接信息',copyUrl:'复制地址',ownerPassword:'Owner Password',
    copyOwner:'复制 Owner Password',ownerCopyUnavailable:'此实例未启用 Owner 密钥复制功能。',
    ownerCopyWarning:'密钥仅会复制到当前浏览器剪贴板，不要粘贴到聊天、日志或截图中。',
    ownerCopyTitle:'确认复制 Owner Password？',ownerCopied:'Owner Password 已复制，请保存到密码管理器。',
    clipboardUnavailable:'无法访问剪贴板，请使用安全的本地终端获取。',
    selectTarget:'选择运行版本',runRollback:'回滚到选定版本',
    rollbackSummary:'回滚前核对',currentRuntime:'当前正在运行',rollbackNotAvailable:'没有通过校验的其他运行版本。',
    rollbackConfirmTitle:'确认切换正在运行的版本？',rollbackConfirmText:'这将重启 MCP 服务并短暂中断连接；会保留现有启动脚本以便失败恢复，不会修改 Tunnel 或密钥。',
    rollbackType:'输入所选版本 ID 以确认：',rollbackPassed:'目标版本已通过运行与健康校验，请重新检查连接。',
    rollbackFailed:'运行版本切换未完成。',rollbackBusy:'服务正在切换，请不要关闭页面。',
    rollbackSha:'构建 SHA-256',rollbackStatus:'选择状态',notCurrent:'可选回滚版本',
    access:'连接与密钥',
  });
  let lang = localStorage.getItem('devspace-console-lang') === 'en' ? 'en' : 'zh';
  let theme = localStorage.getItem('devspace-console-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  let activeView = 'overview';
  let snapshot = null;
  let pendingAction = '';
  let pendingRollback = null;
  let selectedRollbackId = '';
  let requestFilter = '';
  const h = (value) => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const t = (key) => labels[lang][key] || key;
  const v = (value, fallback) => value === null || value === undefined || value === '' ? (fallback || '—') : value;
  const cap = (value, length=60) => { const s=String(v(value));return s.length > length ? s.slice(0,length-1)+'…' : s; };
  const stamp = (value) => { if (!value) return '—'; const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : value; const d=new Date(n); return Number.isNaN(d.getTime()) ? cap(value,30) : new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d); };
  const fmt = (value) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US').format(value) : '—';
  const shortHash = (value) => value ? String(value).slice(0,12) : '—';
  const badge = (label, kind) => '<span class="badge '+h(kind || '')+'">'+h(label)+'</span>';
  const state = (value) => {const s=String(v(value,'unknown')).toLowerCase();return ['active','ok','healthy','running','completed','response_finished','success'].includes(s) ? badge(value,'ok') : ['inactive','failed','aborted','error','dead','unavailable'].includes(s) ? badge(value,'bad') : badge(value,'warn');};
  const row = (label,value,mono=false) => '<div class="kv"><dt>'+h(label)+'</dt><dd class="'+(mono?'mono':'')+'">'+h(v(value,t('notKnown')))+'</dd></div>';
  const panel = (title,subtitle,content,extra='') => '<article class="panel"><div class="panel-head"><div><h2>'+h(title)+'</h2>'+(subtitle?'<p>'+h(subtitle)+'</p>':'')+'</div>'+extra+'</div>'+content+'</article>';
  const empty = (message) => '<div class="empty">'+h(message || t('noRows'))+'</div>';
  const note = (message,kind='') => '<div class="section-note '+h(kind)+'">'+h(message)+'</div>';
  const list = (arr) => Array.isArray(arr) && arr.length ? arr.map((x)=>'<div class="line-item mono">'+h(typeof x==='string'?x:JSON.stringify(x))+'</div>').join('') : empty();
  const dataTable = (headers,records,emptyMsg) => !records.length ? empty(emptyMsg) : '<div class="table-wrap"><table><thead><tr>'+headers.map((x)=>'<th scope="col">'+h(x)+'</th>').join('')+'</tr></thead><tbody>'+records.join('')+'</tbody></table></div>';
  function setLanguage(next) {lang=next;localStorage.setItem('devspace-console-lang',next);document.documentElement.lang=next === 'zh'?'zh-CN':'en';document.querySelectorAll('[data-i18n]').forEach((el)=>el.textContent=t(el.dataset.i18n));$('language').value=next;updateViewText();render();}
  function setTheme(next) {theme=next;document.documentElement.dataset.theme=next;localStorage.setItem('devspace-console-theme',next);$('theme-toggle').textContent=next === 'dark'?'☼':'☾';}
  function updateViewText(){const key=activeView;const title=t(key);$('page-title').textContent=title;$('breadcrumb-label').textContent=title;$('page-description').textContent=t(key+'Desc');}
  function changeView(next){if(!views.includes(next))return;activeView=next;document.querySelectorAll('.view').forEach((el)=>el.classList.toggle('active',el.id==='view-'+next));document.querySelectorAll('.nav-item').forEach((el)=>{let selected=el.dataset.view===next;el.classList.toggle('active',selected);if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});updateViewText();$('sidebar').classList.remove('open');$('menu-toggle').setAttribute('aria-expanded','false');$('mobile-scrim').hidden=true;render();}
  function notice(message,kind='warn'){const n=$('notice');n.textContent=message;n.className='notice '+kind;n.setAttribute('role',kind==='error'?'alert':'status');n.hidden=!message;}
  function renderOverview(d){
    const service=d.services||{},runtime=d.runtime||{},mcp=d.mcp||{},inventory=d.inventory||{},actual=runtime.actual||{},source=runtime.provenance||{};
    const ok=service.devspace==='active' && mcp.local_health?.ok && (!service.tunnel || service.tunnel==='active');
    const git=source.runtime?.git_commit || source.git_commit;
    const stats=[
      [t('runtimeVersion'),v(actual.version,runtime.version),'▣',git ? shortHash(git) : t('noProvenance')],
      [t('activeWorkspaces'),fmt(inventory.workspace_count),'◫',t('observed')],
      [t('jobs'),fmt(inventory.job_count),'▤',t('observed')],
      [t('sessions'),fmt(inventory.workflow_session_count),'◎',t('observed')]
    ];
    const recent=mcp.request_diagnostics?.recent||[];
    const hero='<div class="hero"><div><p>'+h(t('instance'))+' / '+h(v(d.instance))+'</p><h2>'+h(ok?t('healthy'):t('degraded'))+'</h2><div class="description">'+h(t('overviewDesc'))+'</div><div class="hero-meta"><span>'+h(v(d.platform))+'</span><span>'+h(v(actual.version,runtime.version))+'</span><span>'+h(shortHash(git))+'</span></div></div><div class="hero-icon" aria-hidden="true">⬡</div></div>';
    const metrics='<div class="stats-grid">'+stats.map((a)=>'<article class="stat"><div class="stat-head"><span>'+h(a[0])+'</span><span class="stat-icon" aria-hidden="true">'+a[2]+'</span></div><div class="stat-value">'+h(a[1])+'</div><div class="stat-detail">'+h(a[3])+'</div></article>').join('')+'</div>';
    const serviceRows=[['devspaceService',service.devspace],['tunnelService',service.tunnel],['healthLocal',mcp.local_health?.ok?'ok':'unavailable'],['healthPublic',mcp.public_health?.ok?'ok':'unavailable']].map((a)=>'<div class="status-row"><div class="status-label"><span class="glyph" aria-hidden="true">●</span>'+h(t(a[0]))+'</div>'+state(a[1])+'</div>').join('');
    const recentRows=recent.slice(0,5).map((x)=>'<div class="line-item"><div class="status-row"><span class="mono">'+h(shortHash(x.request_id||x.requestId))+'</span>'+state(x.outcome||x.event||x.status)+'</div><div class="meta"><span>'+h(stamp(x.ts))+'</span><span>'+h(v(x.duration_ms,x.durationMs))+' ms</span></div></div>').join('') || empty(t('noRequests'));
    return hero+metrics+'<div class="panel-grid">'+panel(t('serviceHealth'),'','<div class="panel-body"><div class="status-stack">'+serviceRows+'</div></div>')+panel(t('recentRequests'),t('observed'),'<div class="panel-body">'+recentRows+'</div>')+'</div>'+(runtime.pointer_mismatch?note(t('pointerMismatch'),'warning'):'');
  }
  function renderAccess(d){
    const info=d.connection||{};
    const entries=[[t('publicMcpUrl'),info.public_mcp_url],[t('publicBaseUrl'),info.public_base_url],[t('localMcpUrl'),info.local_mcp_url]];
    const urls=entries.map(([title,url])=>'<div class="connection-item"><div><p class="mini-label">'+h(title)+'</p><div class="mono code-text">'+h(v(url))+'</div></div><button class="secondary-button" data-copy-url="'+h(url||'')+'" '+(!url?'disabled':'')+'>'+h(t('copyUrl'))+'</button></div>').join('');
    const enabled=!!d.actions?.copy_owner_password&&!!info.owner_copy_available;
    const owner='<div class="connection-item"><div><p class="mini-label">'+h(t('ownerPassword'))+'</p><div class="mono code-text">•••• •••• ••••</div></div><button class="secondary-button" data-copy-owner '+(!enabled?'disabled':'')+'>'+h(t('copyOwner'))+'</button></div>';
    return panel(t('connectionDetails'),t('accessDesc'),'<div class="panel-body">'+urls+'</div>')+
      panel(t('ownerPassword'),t('ownerCopyWarning'),'<div class="panel-body">'+owner+(enabled?note(t('ownerCopyWarning')):note(t('ownerCopyUnavailable'),'warning'))+'</div>');
  }
  function renderRuntime(d) {
    const rt=d.runtime||{},actual=rt.actual||{},configured=rt.configured||{},prov=rt.provenance||{};
    const control=prov.control||{},source=prov.runtime||{};
    const actualRows=[row(t('pid'),actual.pid),row(t('packageRoot'),actual.package_root,true),row(t('version'),actual.version),row(t('serverHash'),actual.server_sha256,true),row(t('source'),actual.evidence)];
    const declaredRows=[row(t('activeSlot'),rt.active_slot),row(t('packageRoot'),rt.package_root,true),row(t('version'),rt.version),row(t('serverHash'),rt.server_sha256,true)];
    const provenance=[row(t('gitBranch'),source.git_branch||prov.git_branch),row(t('gitCommit'),source.git_commit||prov.git_commit,true),row(t('artifact'),source.artifact_id||prov.artifact_id),row(t('controlVersion'),control.version||prov.control_version),row(t('gitCommit')+' · Control',control.git_commit,true),row(t('origin'),prov.evidence||prov.source)];
    const warning=rt.pointer_mismatch?note(t('pointerMismatch')+(rt.hashes_equal?' '+t('hashMatch'):''),'warning'):'';
    const unverified=!source.git_commit&&!prov.git_commit?note(t('noManifest'),'warning'):'';
    return '<div class="panel-grid equal">'+panel(t('actual'),t('sourceInfo'),'<div class="panel-body">'+actualRows.join('')+'</div>')+panel(t('declared'),t('runtimeInfo'),'<div class="panel-body">'+declaredRows.join('')+'</div>')+'</div>'+warning+panel(t('provenance'),t('sourceInfo'),'<div class="panel-body">'+provenance.join('')+unverified+'</div>');
  }
  function renderConnectivity(d){
    const m=d.mcp||{},tu=d.tunnel||{},metrics=tu.metrics||{},diag=tu.diagnostics||{};
    const connections=metrics.ha_connections??metrics.haConnections??diag.registered_connections;
    const health=[row(t('healthLocal'),m.local_health?.ok?'HTTP '+m.local_health.status:'HTTP '+v(m.local_health?.status,0)),row(t('healthPublic'),m.public_health?.ok?'HTTP '+m.public_health.status:'HTTP '+v(m.public_health?.status,0)),row(t('origin'),m.public_base_url,true),row(t('transport'),m.local_health?.error||m.public_health?.error||'—')];
    const tunnel=[row(t('tunnelService'),d.services?.tunnel),row(t('tunnelConnections'),connections),row(t('protocol'),diag.actual_protocol||diag.protocol||diag.configured_protocol),row(t('lastReconnect'),stamp(diag.last_connected_at||diag.last_registered_at))];
    const warning=typeof connections==='number'&&connections<4?note(t('haPartial'),'warning'):'';
    return '<div class="panel-grid equal">'+panel(t('health'),t('services'),'<div class="panel-body">'+health.join('')+'</div>')+panel(t('connectivity'),'Cloudflare Tunnel','<div class="panel-body">'+tunnel.join('')+warning+'</div>')+'</div>'+note(t('requestsNoClient'));
  }
  function renderRequests(d){
    const info=d.mcp?.request_diagnostics||{},items=Array.isArray(info.recent)?info.recent:[],filtered=items.filter((x)=>JSON.stringify(x).toLowerCase().includes(requestFilter.toLowerCase()));
    const stats='<div class="stats-grid">'+[[t('requestCount'),fmt(info.total_observed)], [t('aborted'),fmt(info.aborted_observed)], [t('scope'),cap(info.observation_scope,30)], [t('status'),info.available?'OK':t('unknown')]].map((a)=>'<article class="stat"><div class="stat-head">'+h(a[0])+'</div><div class="stat-value">'+h(a[1])+'</div></article>').join('')+'</div>';
    const head='<div class="panel-head"><div><h2>'+h(t('requests'))+'</h2><p>'+h(t('requestsNoClient'))+'</p></div><div class="filters"><input class="filter-input" type="search" id="request-filter" aria-label="'+h(t('filter'))+'" placeholder="'+h(t('filter'))+'" value="'+h(requestFilter)+'"></div></div>';
    const rows=filtered.map((x)=>'<tr><td class="mono">'+h(stamp(x.ts))+'</td><td class="mono">'+h(v(x.request_id,x.requestId))+'</td><td class="mono">'+h(v(x.cf_ray,x.cfRay))+'</td><td>'+state(x.status||x.outcome||x.event)+'</td><td>'+h(v(x.duration_ms,x.durationMs))+' ms</td></tr>');
    return stats+'<article class="panel">'+head+dataTable([t('time'),t('requestId'),t('cfRay'),t('status'),t('duration')],rows,t('noRequests'))+'</article>';
  }
  function renderActivity(d){
    const inv=d.inventory||{},workspaces=inv.workspaces||[],workflows=inv.workflow_sessions||[],jobs=inv.jobs||[];
    const workRows=workspaces.map((x)=>'<tr><td class="mono">'+h(v(x.id))+'</td><td class="mono">'+h(v(x.root,x.workspace_root))+'</td><td>'+h(stamp(x.last_used_at||x.lastUsedAt))+'</td></tr>');
    const flowRows=workflows.map((x)=>'<tr><td class="mono">'+h(v(x.id))+'</td><td class="mono">'+h(v(x.workspace_root))+'</td><td>'+state(x.status)+'</td></tr>');
    const jobRows=jobs.map((x)=>'<tr><td class="mono">'+h(v(x.id))+'</td><td class="mono">'+h(cap(x.command||x.working_directory,95))+'</td><td>'+state(x.status)+'</td></tr>');
    const caution=inv.available===false?note(t('inventoryUnavailable')+' '+v(inv.error),'error'):'';
    return caution+panel(t('activeWorkspaces'),t('of')+' '+fmt(inv.workspace_count),dataTable([t('workspaceId'),t('path'),t('lastUsed')],workRows))+panel(t('sessions'),t('of')+' '+fmt(inv.workflow_session_count),dataTable([t('workflowId'),t('path'),t('status')],flowRows))+panel(t('jobs'),t('of')+' '+fmt(inv.job_count),dataTable([t('jobId'),t('command'),t('status')],jobRows));
  }
  function renderDeployment(d){
    const dep=d.deployment||{},rt=d.runtime||{},actions=d.actions||{};
    const rows=[row(t('activeSlot'),dep.active_slot||rt.active_slot),row(t('previousSlot'),dep.previous_slot),row(t('deploymentRoot'),dep.runtime_root,true),row(t('source'),rt.actual?.package_root,true)];
    const buttons=(actions.restart_devspace?'<button class="danger-button" data-action="restart-devspace">'+h(t('restartDevspace'))+'</button>':'')+(actions.restart_tunnel?'<button class="secondary-button" data-action="restart-tunnel">'+h(t('restartTunnel'))+'</button>':'');
    const targets=Array.isArray(dep.rollback_targets)?dep.rollback_targets:[];
    const eligible=targets.filter(x=>x.verified&&!x.current);
    if(!eligible.some(x=>x.id===selectedRollbackId))selectedRollbackId='';
    const chosen=eligible.find(x=>x.id===selectedRollbackId);
    const options='<option value="">'+h(t('selectTarget'))+'</option>'+targets.map(x=>'<option value="'+h(x.id)+'" '+(x.current?'disabled ':'')+(chosen?.id===x.id?'selected':'')+'>'+h(x.id+' · '+x.version+(x.current?' · '+t('currentRuntime'):''))+'</option>').join('');
    const selector=targets.length?'<label for="rollback-target" class="mini-label">'+h(t('selectTarget'))+'</label><select id="rollback-target" class="filter-input rollback-select">'+options+'</select>':empty(t('rollbackNotAvailable'));
    const preview=chosen?'<div class="rollback-preview">'+row(t('version'),chosen.version)+row(t('packageRoot'),chosen.package_root,true)+row(t('rollbackSha'),chosen.server_sha256,true)+row(t('rollbackStatus'),t('notCurrent'))+'</div>':note(t('rollbackNotAvailable'));
    const control='<div class="panel-body">'+selector+preview+'<button class="danger-button rollback-button" data-action="rollback-runtime" '+(!chosen||!actions.rollback_runtime?'disabled':'')+'>'+h(t('runRollback'))+'</button>'+note(t('rollbackConfirmText'),'warning')+'</div>';
    return panel(t('deployment'),t('runtimeInfo'),'<div class="panel-body">'+rows.join('')+'</div>')+'<div class="panel-grid equal">'+panel(t('rollback'),t('rollbackSummary'),control)+panel(t('backups'),'',list(dep.recent_backups))+'</div><div class="action-zone"><div><h2>'+h(t('protectedOps'))+'</h2><p>'+h(t('protectedDesc'))+'</p></div><div class="action-buttons">'+(buttons||badge(t('controlsUnavailable'),'warn'))+'</div></div>';
  }
  function render(){
    if(!snapshot)return;
    const focused=document.activeElement?.id==='request-filter', selection=focused?document.activeElement.selectionStart:0;
    $('footer-instance').textContent=v(snapshot.instance);
    $('updated-at').textContent=t('updated')+': '+stamp(snapshot.generated_at);
    const contents={overview:renderOverview,access:renderAccess,runtime:renderRuntime,connectivity:renderConnectivity,requests:renderRequests,activity:renderActivity,deployment:renderDeployment};
    for(const key of views)$(key+'-content').innerHTML=contents[key](snapshot);
    if(focused&&activeView==='requests'){const input=$('request-filter');input.focus();try{input.setSelectionRange(selection,selection)}catch{}}
  }
  async function refresh(){
    const el=$('refresh');el.disabled=true;
    try{
      const r=await fetch('/api/status',{cache:'no-store',credentials:'same-origin'});
      if(!r.ok)throw new Error('HTTP '+r.status);
      snapshot=await r.json();
      $('poll-indicator').classList.remove('is-error');
      notice('');
      render();
    }catch(error){$('poll-indicator').classList.add('is-error');notice(t('fetchFailed')+' '+error.message,'error');}
    finally{el.disabled=false;}
  }
  async function action(name){
    const allowed={'restart-devspace':'restart_devspace','restart-tunnel':'restart_tunnel','rollback-runtime':'rollback_runtime','copy-owner':'copy_owner_password'};
    if(!allowed[name]||!snapshot?.actions?.[allowed[name]])return;
    pendingRollback=null;
    const isRollback=name==='rollback-runtime';
    if(isRollback){
      const target=snapshot.deployment?.rollback_targets?.find(x=>x.id===selectedRollbackId&&!x.current&&x.verified);
      if(!target)return;
      pendingRollback={target_id:target.id,expected_sha256:target.server_sha256,observed_pid:snapshot.runtime.actual?.pid};
    }
    pendingAction=name;
    $('rollback-confirm-area').hidden=!isRollback;
    $('rollback-confirm-input').value='';
    $('confirm-submit').disabled=isRollback;
    $('rollback-confirm-label').textContent=t('rollbackType')+' '+(pendingRollback?.target_id||'');
    $('confirm-title').textContent=t(isRollback?'rollbackConfirmTitle':name==='copy-owner'?'ownerCopyTitle':'confirmTitle');
    $('confirm-description').textContent=isRollback?t('rollbackConfirmText')+' '+pendingRollback.target_id+' · '+pendingRollback.expected_sha256:(name==='copy-owner'?t('ownerCopyWarning'):t('confirmDesc')+' '+name);
    $('confirm-dialog').showModal();
  }
  async function copyText(value){
    if(!value)throw new Error(t('clipboardUnavailable'));
    if(navigator.clipboard?.writeText){
      try{await navigator.clipboard.writeText(value);return;}catch{}
    }
    const field=document.createElement('textarea');
    field.value=value;field.setAttribute('readonly','');field.style.position='fixed';field.style.opacity='0';field.style.pointerEvents='none';
    document.body.appendChild(field);field.focus();field.select();
    const copied=document.execCommand?.('copy')===true;
    field.remove();
    if(!copied)throw new Error(t('clipboardUnavailable'));
  }
  async function executeAction(name,rollbackRequest){
    const btn=$('confirm-submit');btn.disabled=true;
    try{
      const tokenResponse=await fetch('/api/action-token',{cache:'no-store',credentials:'same-origin'});
      if(!tokenResponse.ok)throw new Error('HTTP '+tokenResponse.status);
      const token=(await tokenResponse.json()).token;
      if(name==='copy-owner'){
        const response=await fetch('/api/credentials/owner',{method:'POST',headers:{'x-devspace-console-token':token,'content-type':'application/json'},body:'{}',cache:'no-store',credentials:'same-origin'});
        if(!response.ok)throw new Error((await response.json()).error||('HTTP '+response.status));
        const result=await response.json();
        await copyText(result.password);
        notice(t('ownerCopied'));
        return;
      }
      if(name==='rollback-runtime')notice(t('rollbackBusy'),'warn');
      const response=await fetch('/api/actions/'+name,{method:'POST',headers:{'x-devspace-console-token':token,'content-type':'application/json'},body:JSON.stringify(name==='rollback-runtime'?rollbackRequest:{}),credentials:'same-origin'});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||('HTTP '+response.status));
      await refresh();
      if(name==='rollback-runtime')selectedRollbackId='';
      notice(t(name==='rollback-runtime'?'rollbackPassed':'actionDone'));
    }catch(error){notice(t('actionFailed')+': '+error.message,'error');}
    finally{btn.disabled=false;}
  }
  document.querySelectorAll('[data-view]').forEach((button)=>button.addEventListener('click',()=>changeView(button.dataset.view)));
  $('language').addEventListener('change',(event)=>setLanguage(event.target.value));
  $('theme-toggle').addEventListener('click',()=>setTheme(theme==='dark'?'light':'dark'));
  $('refresh').addEventListener('click',refresh);
  $('menu-toggle').addEventListener('click',()=>{const next=!$('sidebar').classList.contains('open');$('sidebar').classList.toggle('open',next);$('menu-toggle').setAttribute('aria-expanded',String(next));$('mobile-scrim').hidden=!next;});
  $('mobile-scrim').addEventListener('click',()=>changeView(activeView));
  $('rollback-confirm-input').addEventListener('input',()=>{$('confirm-submit').disabled=$('rollback-confirm-input').value!==pendingRollback?.target_id;});
  $('confirm-dialog').addEventListener('close',()=>{if($('confirm-dialog').returnValue==='confirm'&&pendingAction)executeAction(pendingAction,pendingRollback);pendingAction='';pendingRollback=null;});
  document.addEventListener('click',async(event)=>{
    const copy=event.target.closest('[data-copy-url]');
    if(copy){try{await copyText(copy.dataset.copyUrl);notice(t('copied'));}catch(error){notice(error.message,'error');}return;}
    if(event.target.closest('[data-copy-owner]')){action('copy-owner');return;}
    const button=event.target.closest('[data-action]');if(button)action(button.dataset.action);
  });
  document.addEventListener('change',(event)=>{if(event.target.id==='rollback-target'){selectedRollbackId=event.target.value;render();}});
  document.addEventListener('input',(event)=>{if(event.target.id==='request-filter'){requestFilter=event.target.value;document.querySelectorAll('#requests-content tbody tr').forEach((row)=>row.hidden=!row.textContent.toLowerCase().includes(requestFilter.toLowerCase()));}});
  setTheme(theme);setLanguage(lang);changeView('overview');refresh();setInterval(()=>{if(!document.hidden)refresh();},6000);
})();
