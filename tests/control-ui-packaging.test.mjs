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
