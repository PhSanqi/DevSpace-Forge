import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=(name)=>readFileSync(path.join(root,name),'utf8');

test('Linux release builds and stages the Control UI beside the console',()=>{
  const script=source('package-release-linux.sh');
  assert.match(script,/--prefix "\$ROOT\/control-ui" ci/);
  assert.match(script,/--prefix "\$ROOT\/control-ui" run build/);
  assert.match(script,/cp -a "\$ROOT\/control-ui\/dist" "\$STAGE\/ops\/control-ui"/);
  assert.ok(script.indexOf('control-ui" ci')<script.indexOf('run build'));
  assert.ok(script.indexOf('run build')<script.indexOf('cp -a "$ROOT/control-ui/dist"'));
});

test('Linux installers place the same UI beside runtime-console.mjs',()=>{
  assert.match(source('setup-linux.sh'),/cp -a "\$ROOT\/ops\/control-ui\/\." "\$INSTALL_ROOT\/bin\/control-ui\/"/);
  assert.match(source('ops/install-linux-sidecar-instance.sh'),/cp -a "\$SCRIPT_DIR\/control-ui\/\." "\$INSTALL_ROOT\/bin\/control-ui\/"/);
});

test('Windows release builds and stages the UI under ops/control-ui',()=>{
  const script=source('package-release-windows-payload.ps1');
  assert.match(script,/& npm --prefix \(Join-Path \$root 'control-ui'\) run build/);
  assert.match(script,/Copy-Item \(Join-Path \$root 'control-ui\\dist'\) \(Join-Path \$stage 'ops\\control-ui'\) -Recurse -Force/);
  assert.match(source('ops/start-runtime-console.ps1'),/\$console = Join-Path \$root 'ops\\runtime-console\.mjs'/);
});

test('Control server prefers sibling assets and falls back to source dist',()=>{
  const script=source('ops/runtime-console.mjs');
  assert.match(script,/path\.join\(here,'control-ui'\)/);
  assert.match(script,/existsSync\(packagedNextRoot\)\?packagedNextRoot:path\.join\(here,'\.\.\/control-ui\/dist'\)/);
  assert.match(script,/services\.nextAssetRoot/);
});

test('Linux installer writes secrets privately and quotes systemd ExecStart paths',{skip:process.platform==='win32'},async()=>{
  const { spawnSync } = await import('node:child_process');
  const setup=source('setup-linux.sh');
  const sidecar=source('ops/install-linux-sidecar-instance.sh');
  assert.match(setup,/install -m 0600 \/dev\/null "\$DEVSPACE_CONFIG_DIR\/auth\.json"/);
  assert.equal((setup.match(/install -m 0600 \/dev\/null "\$CLOUDFLARE_TOKEN_FILE"/g)||[]).length,2);
  assert.doesNotMatch(setup,/auth\.json"\s*\n\s*chmod 0600/);
  assert.doesNotMatch(setup,/CLOUDFLARE_TOKEN_FILE"\s*\n\s*chmod 0600/);
  assert.match(setup,/--tunnel-token-file\)/);
  assert.match(setup,/--tunnel-token-stdin\)/);
  assert.match(setup,/warning: --tunnel-token exposes the token in process listings/);
  assert.match(setup,/Description=DevSpace Control - DevSpace MCP server[\s\S]*?UMask=0077/);
  assert.match(setup,/Description=DevSpace Control - Cloudflare Tunnel[\s\S]*?NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nUMask=0077/);
  for(const script of [setup,sidecar]){
    assert.match(script,/systemd_quote\(\) \{/);
    assert.match(script,/ExecStart=\$\(systemd_quote /);
    const fn=script.match(/systemd_quote\(\) \{\n[\s\S]*?\n\}/)[0];
    const result=spawnSync('bash',['-c',`${fn}\nsystemd_quote '/home/u/My Dir/%weird$var"path\\x'`],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,'"/home/u/My Dir/%%weird$$var\\"path\\\\x"');
  }
});

test('tunnel token stdin prompts silently on a TTY and rejects empty input',()=>{
  const script=source('setup-linux.sh');
  const match=script.match(/if \[\[ "\$TUNNEL_TOKEN_STDIN" -eq 1 \]\]; then\n[\s\S]*?\nfi/);
  assert.ok(match,'--tunnel-token-stdin handling block exists');
  const block=match[0];
  assert.ok(block.includes('if [[ -t 0 ]]; then'),'TTY input is detected');
  assert.ok(block.includes("printf 'Cloudflare Remote Tunnel token: ' >&2"),'prompt goes to stderr');
  assert.ok(block.includes('IFS= read -r -s TUNNEL_TOKEN'),'TTY input is read silently');
  assert.ok(block.includes('IFS= read -r TUNNEL_TOKEN'),'non-TTY input reads one line');
  assert.ok(block.includes("echo 'Tunnel token from standard input is empty.' >&2"),'empty token is a clear error');
  assert.ok(block.includes('exit 1'),'empty token exits non-zero');
  assert.doesNotMatch(block,/echo\s+"?\$TUNNEL_TOKEN/,'the token is never echoed');
});
