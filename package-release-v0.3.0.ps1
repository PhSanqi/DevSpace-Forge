param([string]$Version = '0.3.0')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$packageName = "DevSpaceControlPlatform-v$Version-win-x64"
$stage = Join-Path $dist $packageName
$zip = Join-Path $dist "$packageName.zip"
$hashFile = $zip + '.sha256.txt'

& (Join-Path $root 'test.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $root 'test-runtime-slot.ps1') -SlotName 'windows-beta4-local10'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $dist | Out-Null
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip, $hashFile -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

& (Join-Path $root 'build.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'DevSpaceControlPlatform.exe'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

foreach ($file in @(
    'setup-runtime.ps1',
    'setup-serena.ps1',
    'setup-koffi.ps1',
    'prepare-runtime-slot.ps1',
    'test-runtime-slot.ps1',
    'activate-runtime-slot.ps1',
    'rollback-runtime-slot.ps1',
    'switch-v0.3.0-offline.ps1',
    'rollback-v0.3.0-offline.ps1',
    'package.json',
    'README.md',
    'README.zh-CN.md',
    'PLATFORMS.md',
    'LICENSE'
)) {
    Copy-Item (Join-Path $root $file) $stage -Force
}

Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
Set-Content -Path $hashFile -Encoding ASCII -Value "$hash  $packageName.zip"
Write-Host "Created $zip"
Write-Host "SHA256 $hash"
