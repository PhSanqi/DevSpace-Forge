// Development-only fixture. No production services, credentials, or state files.
import { createConsoleServer } from '../ops/runtime-console.mjs';
const data={
  schema_version:2,generated_at:new Date().toISOString(),instance:'server',platform:'linux',
  runtime:{
    version:'1.1.0-beta.4.local.13',package_root:'/home/z/.local/share/devspace-control-server/runtime-local13/node_modules/@waishnav/devspace',
    server_sha256:'f9a445e0270cb0d8c51172d6f140446c4f5e0b22e3b2240a102db7730b1bce97',
    active_slot:'runtime-local13',previous_slot:null,pointer_mismatch:true,hashes_equal:true,
    actual:{pid:1745,package_root:'/home/z/.local/share/devspace-control-server/runtime-local13-candidate-20260924-0118/node_modules/@waishnav/devspace',version:'1.1.0-beta.4.local.13',server_sha256:'f9a445e0270cb0d8c51172d6f140446c4f5e0b22e3b2240a102db7730b1bce97',evidence:'systemd MainPID + /proc cmdline'},
    provenance:{runtime:{git_branch:'runtime/beta4-unified',git_commit:'cb10b77969e4d83ada826e7fa4f8ef693a98f1d6',artifact_id:'candidate-runtime'},control:{version:'0.6.0',git_commit:'1e7c2b42ff623583bc28b69f42845a6a317d2dad'},evidence:'matched installed server.js SHA-256'},
  },
  deployment:{active_slot:'runtime-local13',previous_slot:null,runtime_root:'/home/z/.local/share/devspace-control-server/runtime-local13-candidate-20260924-0118',rollback_candidates:['runtime-local12','runtime-local13'],rollback_targets:[
    {id:'runtime-local12',version:'1.1.0-beta.4.local.12',package_root:'/home/z/.local/share/devspace-control-server/runtime-local12/node_modules/@waishnav/devspace',server_sha256:'a'.repeat(64),current:false,verified:true},
    {id:'runtime-local13',version:'1.1.0-beta.4.local.13',package_root:'/home/z/.local/share/devspace-control-server/runtime-local13/node_modules/@waishnav/devspace',server_sha256:'b'.repeat(64),current:false,verified:true},
    {id:'runtime-local13-candidate-20260924-0118',version:'1.1.0-beta.4.local.13',package_root:'/home/z/.local/share/devspace-control-server/runtime-local13-candidate-20260924-0118/node_modules/@waishnav/devspace',server_sha256:'f9a445e0270cb0d8c51172d6f140446c4f5e0b22e3b2240a102db7730b1bce97',current:true,verified:true}
  ],recent_backups:['deploy-20260924-0121']},
  services:{devspace:'active',tunnel:'active'},
  mcp:{public_base_url:'https://dev.sanqi.org/server',local_health:{ok:true,status:200,duration_ms:11},public_health:{ok:true,status:200,duration_ms:78},request_diagnostics:{available:true,observation_scope:'origin HTTP',total_observed:178,aborted_observed:2,recent:[
    {ts:new Date().toISOString(),request_id:'92427498-4a9b-4b0f-a9e1-88839377281f',cf_ray:'a3fb45526f0f832c-KIX',status:200,outcome:'response_finished',duration_ms:83},
    {ts:new Date().toISOString(),request_id:'989fd58f-aeb6-450d-853b-1f94da45c4c8',cf_ray:'a3ff3f25d986c087-NRT',status:200,outcome:'response_finished',duration_ms:120}
  ]}},
  tunnel:{metrics:{ha_connections:4},diagnostics:{actual_protocol:'quic',registered_connections:4,last_registered_at:new Date().toISOString()}},
  inventory:{workspace_count:117,workflow_session_count:2,job_count:3,available:true,workspaces:[{id:'ws_5b9de9ee0e',root:'/home/z/codex-workspace/DevSpace-Forge',last_used_at:Date.now()}],workflow_sessions:[{id:'workflow-001',workspace_root:'/home/z/codex-workspace/DevSpace-Forge',status:'completed'}],jobs:[{id:'job-001',command:'pnpm test',status:'completed'}]},
  connection:{public_base_url:'https://dev.sanqi.org/server',public_mcp_url:'https://dev.sanqi.org/server/mcp',local_mcp_url:'http://127.0.0.1:17677/server/mcp',owner_copy_available:true},
  management:{
    settings:{allowed_roots:['/home/z/codex-workspace'],local_port:17677,public_base_url:'https://dev.sanqi.org/server',effective_public_base_url:'https://dev.sanqi.org/server',quick_public_origin:null,public_base_path:'/server',tunnel_mode:'Remote',tunnel_token_present:true,auto_start:true,tool_mode:'codex',review_ui_enabled:true,skills_enabled:true,skill_paths:[],subagents_enabled:false,logging:{level:'info',format:'json',requests:true,tool_calls:true,shell_commands:false}},
    services:{devspace:{status:'active',enabled:'enabled',pid:1745},tunnel:{status:'active',enabled:'enabled',pid:1056510}},
    paths:{config:'/home/z/.config/devspace-control-server/devspace/config.jsonc',state:'/home/z/.local/share/devspace-control-server/state/devspace-state',worktrees:'/home/z/.local/share/devspace-control-server/state/worktrees',agent_dir:'/home/z/.local/share/devspace-control-server/state/agent-home'},
    config_history:[{id:'2026-09-24T13-00-00-000Z-save.json',created_at:new Date().toISOString(),bytes:1365}],
    projects:[{id:'project-1',name:'DevSpace-Forge',root:'/home/z/codex-workspace/DevSpace-Forge',branch:'runtime/beta4-unified',head:'cb10b77969',dirty:false}],
    runtime_version:'1.1.0-beta.4.local.13'
  },
  security:{credentials_included:false,loopback_console_only:true},actions:{restart_devspace:false,restart_tunnel:false,rollback_runtime:true,copy_owner_password:true}
};
const options={serve:Number(process.env.CONSOLE_PREVIEW_PORT||17689),serviceUnit:'',tunnelUnit:''};
const projectFixture={project:{id:'project-1',name:'DevSpace-Forge',root:'/home/z/codex-workspace/DevSpace-Forge',branch:'runtime/beta4-unified',head:'cb10b77969',dirty:false,commit_count:214,head_summary:'Control Console parity'},commits:[
  {commit:'cb10b77969e4d83ada826e7fa4f8ef693a98f1d6',short_commit:'cb10b77969',created_at:new Date().toISOString(),summary:'Runtime payload improvements'},
  {commit:'8639db1b8cb0968b6dc7ed910cf3a66fb0a9647b',short_commit:'8639db1b8c',created_at:new Date(Date.now()-3600000).toISOString(),summary:'Runtime local13 baseline'}
],review:{initialized:true,current_ref:'c'.repeat(40),versions:[
  {version:'V0',review_ref:'a'.repeat(40),created_at:new Date(Date.now()-7200000).toISOString(),summary:'Workspace 初始基线',is_current:false,is_active:true,is_baseline:true,rollback_steps:2,status:'rollback'},
  {version:'V1',review_ref:'b'.repeat(40),workspace_id:'ws_5b9de9ee0e',created_at:new Date(Date.now()-3600000).toISOString(),summary:'Connection management',is_current:false,is_active:true,is_baseline:false,rollback_steps:1,status:'rollback'},
  {version:'V2',review_ref:'c'.repeat(40),workspace_id:'ws_5b9de9ee0e',created_at:new Date().toISOString(),summary:'Current UI work',is_current:true,is_active:true,is_baseline:false,rollback_steps:0,status:'current'}
]}};
const historyFixture={id:'2026-09-24T13-00-00-000Z-save.json',config:{configVersion:1,server:{host:'127.0.0.1',port:17677,publicBaseUrl:'https://dev.sanqi.org/server'},workspaces:{allowedRoots:['/home/z/codex-workspace'],worktreeRoot:'/home/z/.local/share/devspace-control-server/state/worktrees'},storage:{stateDir:'/home/z/.local/share/devspace-control-server/state/devspace-state'},tools:{mode:'codex'},ui:{enabled:true},skills:{enabled:true,paths:[]},subagents:{enabled:false},logging:{level:'info',format:'json',requests:true,toolCalls:true,shellCommands:false}},control:{schema_version:1,tunnel_mode:'Remote',remote_public_base_url:'https://dev.sanqi.org/server',public_base_path:'/server'}};
const app=createConsoleServer(options,{
  snapshot:async()=>({...data,generated_at:new Date().toISOString()}),
  projectDetails:()=>projectFixture,
  configHistoryItem:()=>historyFixture,
  workspaceActivity:()=>({latest_tool:'exec_command',log:new Date().toISOString()+' | tool_call | exec_command | /home/z/codex-workspace/DevSpace-Forge'})
});
app.listen(options.serve,'127.0.0.1',()=>console.log('preview=http://127.0.0.1:'+options.serve+'/'));
