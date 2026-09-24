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
  deployment:{active_slot:'runtime-local13',previous_slot:null,runtime_root:'/home/z/.local/share/devspace-control-server/runtime-local13-candidate-20260924-0118',rollback_candidates:['runtime-local12','runtime-local13'],recent_backups:['deploy-20260924-0121']},
  services:{devspace:'active',tunnel:'active'},
  mcp:{public_base_url:'https://dev.sanqi.org/server',local_health:{ok:true,status:200,duration_ms:11},public_health:{ok:true,status:200,duration_ms:78},request_diagnostics:{available:true,observation_scope:'origin HTTP',total_observed:178,aborted_observed:2,recent:[
    {ts:new Date().toISOString(),request_id:'92427498-4a9b-4b0f-a9e1-88839377281f',cf_ray:'a3fb45526f0f832c-KIX',status:200,outcome:'response_finished',duration_ms:83},
    {ts:new Date().toISOString(),request_id:'989fd58f-aeb6-450d-853b-1f94da45c4c8',cf_ray:'a3ff3f25d986c087-NRT',status:200,outcome:'response_finished',duration_ms:120}
  ]}},
  tunnel:{metrics:{ha_connections:4},diagnostics:{actual_protocol:'quic',registered_connections:4,last_registered_at:new Date().toISOString()}},
  inventory:{workspace_count:117,workflow_session_count:2,job_count:3,available:true,workspaces:[{id:'ws_5b9de9ee0e',root:'/home/z/codex-workspace/DevSpace-Forge',last_used_at:Date.now()}],workflow_sessions:[{id:'workflow-001',workspace_root:'/home/z/codex-workspace/DevSpace-Forge',status:'completed'}],jobs:[{id:'job-001',command:'pnpm test',status:'completed'}]},
  security:{credentials_included:false,loopback_console_only:true},actions:{restart_devspace:false,restart_tunnel:false}
};
const options={serve:Number(process.env.CONSOLE_PREVIEW_PORT||17689),serviceUnit:'',tunnelUnit:''};
const app=createConsoleServer(options,{snapshot:async()=>({...data,generated_at:new Date().toISOString()})});
app.listen(options.serve,'127.0.0.1',()=>console.log('preview=http://127.0.0.1:'+options.serve+'/'));
