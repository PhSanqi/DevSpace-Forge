param(
    [string]$SlotName = 'windows-local7-win1',
    [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$slot = Join-Path $root (Join-Path 'runtime\slots' $SlotName)
if (-not (Test-Path -LiteralPath (Join-Path $slot 'READY'))) { throw "Runtime slot is not ready: $SlotName" }

$node = Join-Path $slot 'node\node.exe'
$packageRoot = Join-Path $slot 'devspace\node_modules\@waishnav\devspace'
$cli = Join-Path $packageRoot 'dist\cli.js'
$version = (Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'package.json') | ConvertFrom-Json).version
$readyVersion = (Get-Content -Raw -LiteralPath (Join-Path $slot 'READY')).Trim()
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { $ExpectedVersion = $readyVersion }

Write-Host "slot=$SlotName"
Write-Host "node=$(& $node --version)"
Write-Host "devspace=$(& $node $cli --version)"

if ($version -ne $ExpectedVersion) { throw "Unexpected slot version: $version (expected $ExpectedVersion)" }

$configCandidates = @(
    (Join-Path $root 'state\devspace-config'),
    (Join-Path $root 'bin\state\devspace-config')
)
$configDir = $configCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'config.jsonc') } | Select-Object -First 1
if ($configDir) {
    $previousConfig = $env:DEVSPACE_CONFIG_DIR
    try {
        $env:DEVSPACE_CONFIG_DIR = $configDir
        & $node $cli doctor
        if ($LASTEXITCODE -ne 0) { throw "Staged runtime doctor failed with code $LASTEXITCODE" }
    }
    finally {
        $env:DEVSPACE_CONFIG_DIR = $previousConfig
    }
} else {
    Write-Host 'doctor=skipped (managed config not found from project root)'
}

$smoke = @'
const root = process.argv[1];
const { pathToFileURL } = await import('node:url');
for (const name of ['context-intelligence.js', 'serena-semantic.js', 'mcp-modern-server.js', 'image-read.js']) {
  await import(pathToFileURL(root + '/dist/' + name));
}
console.log('context-modules=ok');
'@
& $node --input-type=module -e $smoke $packageRoot.Replace('\','/')
if ($LASTEXITCODE -ne 0) { throw 'Context module import smoke failed.' }

$koffiSmoke = @'
import koffi from 'koffi';
const kernel32 = koffi.load('kernel32.dll');
const getCurrentProcessId = kernel32.func('uint32_t GetCurrentProcessId()');
const pid = getCurrentProcessId();
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Koffi Win32 call failed');
console.log(`koffi-win32=ok pid=${pid}`);
'@
Push-Location (Join-Path $slot 'devspace')
try {
    & $node --input-type=module -e $koffiSmoke
    if ($LASTEXITCODE -ne 0) { throw 'Koffi Win32 smoke failed.' }
}
finally {
    Pop-Location
}

$serenaExe = Join-Path $root 'runtime\serena\bin\serena.exe'
if (-not (Test-Path -LiteralPath $serenaExe)) { throw "Serena CLI is missing: $serenaExe" }
$serenaVersion = (& $serenaExe --version 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $serenaVersion -notmatch '1\.7\.0') {
    throw "Serena validation failed: $serenaVersion"
}
Write-Host "serena=$serenaVersion"

Write-Host 'Runtime slot smoke passed.'
