param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'dist\win-unpacked')
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$electronPackage = Join-Path $root 'node_modules\electron'
$electron = Join-Path $electronPackage 'dist'
$output = [IO.Path]::GetFullPath($OutputPath)
$sourceExe = Join-Path $electron 'electron.exe'
$sourceResources = Join-Path $electron 'resources'
if ($env:OS -ne 'Windows_NT' -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
    throw 'Desktop packaging requires Windows x64.'
}
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $sourceResources -PathType Container)) {
    $installer = Join-Path $electronPackage 'install.js'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw 'Electron package is missing. Run npm ci in desktop-shell first.'
    }
    Write-Host '[desktop] preparing Electron Windows x64 distribution'
    & node $installer
    if ($LASTEXITCODE -ne 0 -or
        -not (Test-Path -LiteralPath $sourceExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $sourceResources -PathType Container)) {
        throw 'Electron Windows x64 distribution could not be prepared. Pre-seed node_modules\electron\dist with the matching Electron version or restore download access.'
    }
}
$reader = [IO.BinaryReader]::new([IO.File]::OpenRead($sourceExe))
try {
    $reader.BaseStream.Position = 0x3c
    $reader.BaseStream.Position = $reader.ReadInt32()
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
        throw 'Electron executable is not Windows x64.'
    }
}
finally { $reader.Dispose() }
if (Test-Path -LiteralPath (Join-Path $sourceResources 'app')) {
    throw 'Electron distribution unexpectedly contains resources/app.'
}
if (Test-Path -LiteralPath $output) { throw "Desktop output already exists: $output" }

New-Item -ItemType Directory -Force (Split-Path -Parent $output) | Out-Null
Copy-Item -LiteralPath $electron -Destination $output -Recurse
Rename-Item -LiteralPath (Join-Path $output 'electron.exe') -NewName 'DevSpaceForgeDesktop.exe'
$app = Join-Path $output 'resources\app'
New-Item -ItemType Directory $app | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'main.cjs') -Destination $app
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $root) 'DevSpaceControlPlatform.ico') -Destination (Join-Path $app 'DevSpaceForge.ico')
Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding ASCII -NoNewline -Value '{"name":"devspace-forge-desktop","version":"0.0.0","main":"main.cjs"}'
Write-Host "Packaged $output"
