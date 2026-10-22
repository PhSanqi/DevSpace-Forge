import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => readFileSync(path.join(root, name), 'utf8');

test('desktop package uses the existing Electron distribution and minimal app payload', () => {
  const manifest = JSON.parse(source('desktop-shell/package.json'));
  const lock = JSON.parse(source('desktop-shell/package-lock.json'));
  for (const dependencies of [manifest.dependencies || {}, manifest.devDependencies || {},
    lock.packages[''].dependencies || {}, lock.packages[''].devDependencies || {}]) {
    assert.ok(!Object.keys(dependencies).some((name) => /electron-builder|electron-packager|squirrel/i.test(name)));
  }
  const script = source('desktop-shell/package-windows.ps1');
  assert.match(script, /node_modules\\electron\\dist/);
  assert.match(script, /node_modules\\electron/);
  assert.match(script, /install\.js/);
  assert.match(script, /& node \$installer/);
  assert.match(script, /Pre-seed node_modules\\electron\\dist/);
  assert.match(script, /dist\\win-unpacked/);
  assert.match(script, /\[string\]\$OutputPath/);
  assert.match(script, /electron\.exe/);
  assert.match(script, /resources/);
  assert.match(script, /Rename-Item.*DevSpaceForgeDesktop\.exe/);
  assert.match(script, /Copy-Item -LiteralPath \(Join-Path \$root 'main\.cjs'\) -Destination \$app/);
  assert.match(script, /DevSpaceControlPlatform\.ico/);
  assert.match(script, /DevSpaceForge\.ico/);
  assert.match(script, /Set-Content.*package\.json.*"main":"main\.cjs"/);
  assert.doesNotMatch(script, /Copy-Item.*node_modules.*-Destination \$app/);
  assert.match(script, /if \(Test-Path -LiteralPath \$output\) \{ throw/);
});

test('Windows release stages the modern shell while retaining the legacy binary for migration compatibility', () => {
  const script = source('package-release-windows-payload.ps1');
  assert.match(script, /control-ui'\) ci/);
  assert.match(script, /desktop-shell'\) ci/);
  assert.match(script, /desktop-shell'\) run typecheck/);
  assert.match(script, /desktop-shell\\package-windows\.ps1/);
  assert.match(script, /package-windows\.ps1'\) -OutputPath \(Join-Path \$stage 'desktop'\)/);
  assert.match(script, /'start-modern-desktop\.ps1'/);
  assert.match(script, /build-setup\.ps1/);
  assert.match(script, /DevSpaceControlPlatform\.exe/);
  assert.doesNotMatch(script, /update-control-platform-out-of-band\.ps1/);
});


test('Windows setup, autostart and script entrypoints use the modern desktop launcher', () => {
  const installer = source('src/SetupInstaller.cs');
  const supervisor = source('src/ServiceSupervisor.cs');
  const setup = source('src/SetupForm.cs');
  const install = source('install.ps1');
  assert.match(installer, /start-modern-desktop\.ps1/);
  assert.match(installer, /DevSpaceForgeDesktop\.exe/);
  assert.match(installer, /WindowsAutoStartCommand[\s\S]*powershell\.exe/);
  assert.match(installer, /ApplyWindowsLaunchShortcuts/);
  assert.match(installer, /SpecialFolder\.Programs/);
  assert.match(installer, /SpecialFolder\.DesktopDirectory/);
  assert.match(installer, /DevSpace-Forge\.lnk/);
  assert.match(installer, /WScript\.Shell/);
  assert.match(installer, /CreateShortcut/);
  assert.match(installer, /DevSpaceForge\.ico/);
  assert.match(installer, /hadProgramsShortcut = File\.Exists\(programsShortcut\)/);
  assert.match(installer, /hadDesktopShortcut = File\.Exists\(desktopShortcut\)/);
  assert.match(installer, /if \(!hadProgramsShortcut && !hadDesktopShortcut\)/);
  assert.match(installer, /ApplyWindowsAutoStart\(root, autoStart\);[\s\S]*ApplyWindowsLaunchShortcuts\(root\);/);
  assert.match(installer, /if \(applySystemIntegration\) ApplyWindowsLaunchShortcuts\(root\);/);
  assert.match(installer, /LegacyWindowsAutoStartValueName[\s\S]*DevSpaceControlPlatform-/);
  assert.match(installer, /key\.DeleteValue\(legacyValueName, false\)/);
  assert.match(supervisor, /SetupInstaller\.ApplyWindowsAutoStart\(platformRoot, enabled\)/);
  assert.doesNotMatch(supervisor, /Process\.GetCurrentProcess\(\)\.MainModule\.FileName/);
  assert.match(installer, /CopyDirectoryContents\(Path\.Combine\(source, "desktop"\)/);
  assert.match(installer, /CopyDirectoryContents\(Path\.Combine\(sourceOps, "control-ui"\)/);
  assert.doesNotMatch(installer, /"update-control-platform-out-of-band\.ps1"/);
  assert.match(installer, /"DevSpaceForgeDesktop", "node", "cloudflared"/);
  assert.match(setup, /SetupInstaller\.StartWindowsDesktop\(platformRoot\)/);
  assert.doesNotMatch(setup, /Path\.Combine\(platformRoot, "DevSpaceControlPlatform\.exe"\)/);
  assert.match(install, /start-modern-desktop\.ps1/);
  assert.match(install, /Join-Path \$root 'Setup\.exe'/);
  assert.doesNotMatch(install, /setup-runtime\.ps1/);
  assert.match(install, /DevSpaceForgeDesktop\.exe/);
  assert.doesNotMatch(install, /Start-Process -FilePath \$exe/);
});

test('launcher attaches on loopback, guards same-root legacy ownership, and has bounded startup', () => {
  const script = source('ops/start-modern-desktop.ps1');
  assert.match(script, /function Resolve-ControlInstance/);
  assert.match(script, /FixedHostname/);
  assert.match(script, /\$body\.instance -ne \$instance/);
  assert.match(script, /'-Instance', \$instance/);
  assert.doesNotMatch(script, /\$body\.instance -ne 'group'/);
  assert.doesNotMatch(script, /'-Instance', 'group'/);
  assert.match(script, /runtime\\active-slot\.txt/);
  assert.match(script, /runtime-console\.mjs/);
  assert.match(script, /desktop\\DevSpaceForgeDesktop\.exe/);
  assert.match(script, /Get-CimInstance Win32_Process.*DevSpaceControlPlatform\.exe/);
  assert.match(script, /\[IO\.Path\]::GetFullPath\(\$_.ExecutablePath\), \$legacy/);
  assert.match(script, /\[Threading\.Mutex\]/);
  assert.match(script, /WaitOne\(\[TimeSpan\]::FromSeconds\(15\)\)/);
  assert.match(script, /127\.0\.0\.1:17678\/api\/status/);
  assert.match(script, /runtime\.configured\.package_root/);
  assert.match(script, /Control conflict: port 17678 belongs to another platform root/);
  assert.match(script, /\$ready = Test-ControlReady/);
  assert.match(script, /if \(-not \$ready\)/);
  assert.match(script, /start-runtime-console\.ps1/);
  assert.match(script, /Start-Process -FilePath 'powershell\.exe'[\s\S]*-WindowStyle Hidden/);
  assert.match(script, /AddSeconds\(30\)/);
  assert.match(script, /DEVSPACE_CONTROL_URL = \$url/);
  assert.match(script, /Start-Process -FilePath \$desktop -PassThru -Wait/);
  assert.match(script, /\$desktopProcess\.ExitCode/);
  assert.doesNotMatch(script, /& \$desktop/);
  assert.doesNotMatch(script, /(?:owner|tunnel)[_-]?token|Stop-Process|Kill\(/i);
});

test('shell defaults to the mature loopback console and keeps same-origin navigation restrictions', () => {
  const script = source('desktop-shell/main.cjs');
  const module = { exports: {} };
  vm.runInNewContext(script, {
    module, process: { env: {} }, URL,
    __dirname: path.join(root, 'desktop-shell'),
    require: (id) => id === 'node:path'
      ? path
      : ({ app: { whenReady: () => new Promise(() => {}), on: () => {} } })
  });
  const { controlUrl } = module.exports;
  assert.equal(controlUrl().pathname, '/');
  assert.equal(controlUrl('http://127.0.0.1:17678/').pathname, '/');
  assert.equal(controlUrl('http://127.0.0.1:17678/next/').pathname, '/next/');
  for (const url of ['https://127.0.0.1:17678/', 'http://example.com/',
    'http://127.0.0.1:17678/runtime-console-ui.js']) {
    assert.throws(() => controlUrl(url));
  }
  assert.match(script, /url\.protocol !== 'http:'/);
  assert.match(script, /'127\.0\.0\.1', '\[::1\]'/);
  assert.match(script, /url\.pathname === '\/'/);
  assert.match(script, /url\.pathname\.startsWith\('\/next\/'\)/);
  assert.match(script, /url\.origin === target\.origin/);
  assert.doesNotMatch(script, /return url\.origin === target\.origin && url\.pathname\.startsWith\('\/next\/'\)/);
  assert.match(script, /will-navigate/);
  assert.match(script, /will-redirect/);
  assert.match(script, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(script, /Control is unavailable/);
  assert.match(script, /const appIcon = path\.join\(__dirname, 'DevSpaceForge\.ico'\)/);
  assert.match(script, /icon: appIcon/);
  assert.match(script, /setAppUserModelId\('DevSpaceForge\.Desktop'\)/);
  assert.match(script, /new Tray\(appIcon\)/);
  assert.match(script, /window\.on\('close'/);
  assert.match(script, /event\.preventDefault\(\)/);
  assert.match(script, /window\.hide\(\)/);
  assert.match(script, /Open DevSpace-Forge/);
  assert.match(script, /label: 'Exit'/);
  assert.match(script, /tray\.on\('click', showMainWindow\)/);
  assert.doesNotMatch(script, /window-all-closed[\s\S]*app\.quit/);
});

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], { encoding: 'utf8' }).status === 0;
test('PowerShell sources parse when pwsh is available', { skip: !hasPwsh }, () => {
  for (const file of ['desktop-shell/package-windows.ps1', 'ops/start-modern-desktop.ps1', 'package-release-windows-payload.ps1', 'install.ps1']) {
    const result = spawnSync('pwsh', ['-NoProfile', '-Command',
      '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:PS_SOURCE_FILE,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }'],
      { encoding: 'utf8', env: { ...process.env, PS_SOURCE_FILE: path.join(root, file) } });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('shell accepts the /next Control URL without a trailing slash', () => {
  const script = source('desktop-shell/main.cjs');
  const module = { exports: {} };
  vm.runInNewContext(script, {
    module, process: { env: {} }, URL,
    __dirname: path.join(root, 'desktop-shell'),
    require: (id) => id === 'node:path'
      ? path
      : ({ app: { whenReady: () => new Promise(() => {}), on: () => {} } })
  });
  const { controlUrl } = module.exports;
  assert.equal(controlUrl('http://127.0.0.1:17678/next').pathname, '/next');
  assert.equal(controlUrl('http://127.0.0.1:17678/next/connection').pathname, '/next/connection');
  assert.throws(() => controlUrl('http://127.0.0.1:17678/nextish'));
});
