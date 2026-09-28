// Development-only fixture. No production services, credentials, or state files.
import { createConsoleServer } from '../ops/runtime-console.mjs';
const data={
  schema_version:2,generated_at:new Date().toISOString(),instance:'server',platform:'linux',
  runtime:{
    version:'1.1.0-test.1',package_root:'/tmp/devspace-test/data/devspace-control-server/runtime-slot-current/node_modules/@waishnav/devspace',
    server_sha256:'d'.repeat(64),
    active_slot:'runtime-slot-current',previous_slot:'runtime-slot-previous',pointer_mismatch:true,hashes_equal:true,
    actual:{pid:4242,package_root:'/tmp/devspace-test/data/devspace-control-server/runtime-slot-candidate/node_modules/@waishnav/devspace',version:'1.1.0-test.1',server_sha256:'d'.repeat(64),evidence:'systemd MainPID + /proc cmdline'},
    provenance:{runtime:{git_branch:'runtime/example',git_commit:'1'.repeat(40),artifact_id:'candidate-runtime'},control:{version:'0.0.0-test',git_commit:'2'.repeat(40)},evidence:'matched installed server.js SHA-256'},
  },
  deployment:{active_slot:'runtime-slot-current',previous_slot:'runtime-slot-previous',runtime_root:'/tmp/devspace-test/data/devspace-control-server/runtime-slot-candidate',rollback_candidates:['runtime-slot-previous','runtime-slot-current'],rollback_targets:[
    {id:'runtime-slot-previous',version:'1.1.0-test.0',package_root:'/tmp/devspace-test/data/devspace-control-server/runtime-slot-previous/node_modules/@waishnav/devspace',server_sha256:'a'.repeat(64),current:false,verified:true},
    {id:'runtime-slot-current',version:'1.1.0-test.1',package_root:'/tmp/devspace-test/data/devspace-control-server/runtime-slot-current/node_modules/@waishnav/devspace',server_sha256:'b'.repeat(64),current:false,verified:true},
    {id:'runtime-slot-candidate',version:'1.1.0-test.1',package_root:'/tmp/devspace-test/data/devspace-control-server/runtime-slot-candidate/node_modules/@waishnav/devspace',server_sha256:'d'.repeat(64),current:true,verified:true}
  ],recent_backups:['fixture-backup-01']},
  services:{devspace:'active',tunnel:'active'},
  mcp:{public_base_url:'https://workspace.example.com/server',local_health:{ok:true,status:200,duration_ms:11},public_health:{ok:true,status:200,duration_ms:78},request_diagnostics:{available:true,observation_scope:'origin HTTP',total_observed:178,aborted_observed:2,recent:[
    {ts:new Date().toISOString(),request_id:'00000000-0000-4000-8000-000000000001',cf_ray:'fixture-ray-01',status:200,outcome:'response_finished',duration_ms:83},
    {ts:new Date().toISOString(),request_id:'00000000-0000-4000-8000-000000000002',cf_ray:'fixture-ray-02',status:200,outcome:'response_finished',duration_ms:120}
  ]}},
  tunnel:{metrics:{ha_connections:4},diagnostics:{actual_protocol:'quic',registered_connections:4,last_registered_at:new Date().toISOString()}},
  inventory:{workspace_count:3,workflow_session_count:2,job_count:3,available:true,workspaces:[{id:'ws_fixture_01',root:'/tmp/devspace-test/projects/example-project',last_used_at:Date.now()}],workflow_sessions:[{id:'workflow-001',workspace_root:'/tmp/devspace-test/projects/example-project',status:'completed'}],jobs:[{id:'job-001',command:'pnpm test',status:'completed'}]},
  connection:{public_base_url:'https://workspace.example.com/server',public_mcp_url:'https://workspace.example.com/server/mcp',local_mcp_url:'http://127.0.0.1:17677/server/mcp',owner_copy_available:true},
  management:{
    settings:{allowed_roots:['/tmp/devspace-test/projects'],local_port:17677,public_base_url:'https://workspace.example.com/server',effective_public_base_url:'https://workspace.example.com/server',quick_public_origin:null,public_base_path:'/server',tunnel_mode:'Remote',tunnel_token_present:true,auto_start:true,tool_mode:'codex',review_ui_enabled:true,skills_enabled:true,skill_paths:[],subagents_enabled:false,logging:{level:'info',format:'json',requests:true,tool_calls:true,shell_commands:false}},
    services:{devspace:{status:'active',enabled:'enabled',pid:4242},tunnel:{status:'active',enabled:'enabled',pid:4343}},
    paths:{config:'/tmp/devspace-test/config/devspace-control-server/devspace/config.jsonc',state:'/tmp/devspace-test/data/devspace-control-server/state/devspace-state',worktrees:'/tmp/devspace-test/data/devspace-control-server/state/worktrees',agent_dir:'/tmp/devspace-test/data/devspace-control-server/state/agent-home'},
    config_history:[{id:'fixture-config-save.json',created_at:new Date().toISOString(),bytes:1365}],
    projects:[{id:'project-1',name:'example-project',root:'/tmp/devspace-test/projects/example-project',branch:'feature/example',head:'1111111111',dirty:false}],
    runtime_version:'1.1.0-test.1'
  },
  security:{credentials_included:false,loopback_console_only:true},actions:{restart_devspace:false,restart_tunnel:false,rollback_runtime:true,copy_owner_password:true}
};
const options={serve:Number(process.env.CONSOLE_PREVIEW_PORT||17689),serviceUnit:'',tunnelUnit:''};
const projectFixture={project:{id:'project-1',name:'example-project',root:'/tmp/devspace-test/projects/example-project',branch:'feature/example',head:'1111111111',dirty:false,commit_count:12,head_summary:'Example project update'},commits:[
  {commit:'1'.repeat(40),short_commit:'1111111111',created_at:new Date().toISOString(),summary:'Example feature update'},
  {commit:'2'.repeat(40),short_commit:'2222222222',created_at:new Date(Date.now()-3600000).toISOString(),summary:'Example baseline'}
],review:{initialized:true,current_ref:'c'.repeat(40),versions:[
  {version:'V0',review_ref:'a'.repeat(40),created_at:new Date(Date.now()-7200000).toISOString(),summary:'Workspace 初始基线',is_current:false,is_active:true,is_baseline:true,rollback_steps:2,status:'rollback'},
  {version:'V1',review_ref:'b'.repeat(40),workspace_id:'ws_fixture_01',created_at:new Date(Date.now()-3600000).toISOString(),summary:'Connection management',is_current:false,is_active:true,is_baseline:false,rollback_steps:1,status:'rollback'},
  {version:'V2',review_ref:'c'.repeat(40),workspace_id:'ws_fixture_01',created_at:new Date().toISOString(),summary:'Current UI work',is_current:true,is_active:true,is_baseline:false,rollback_steps:0,status:'current'}
]}};
const historyFixture={id:'fixture-config-save.json',config:{configVersion:1,server:{host:'127.0.0.1',port:17677,publicBaseUrl:'https://workspace.example.com/server'},workspaces:{allowedRoots:['/tmp/devspace-test/projects'],worktreeRoot:'/tmp/devspace-test/data/devspace-control-server/state/worktrees'},storage:{stateDir:'/tmp/devspace-test/data/devspace-control-server/state/devspace-state'},tools:{mode:'minimal'},ui:{enabled:true},skills:{enabled:true,paths:[]},subagents:{enabled:false},logging:{level:'info',format:'json',requests:true,toolCalls:true,shellCommands:false}},control:{schema_version:1,tunnel_mode:'Remote',remote_public_base_url:'https://workspace.example.com/server',public_base_path:'/server'}};
const app=createConsoleServer(options,{
  snapshot:async()=>({...data,generated_at:new Date().toISOString()}),
  projectDetails:()=>projectFixture,
  configHistoryItem:()=>historyFixture,
  workspaceActivity:()=>({latest_tool:'exec_command',log:new Date().toISOString()+' | tool_call | exec_command | /tmp/devspace-test/projects/example-project'})
});
app.listen(options.serve,'127.0.0.1',()=>console.log('preview=http://127.0.0.1:'+options.serve+'/'));
