param(
    [string]$SlotName = 'windows-local7-win1',
    [string]$SlotPath,
    [switch]$NoDownload
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$cache = Join-Path $runtime 'cache'
$koffiVersion = '3.2.1'
$coreName = "koffi-$koffiVersion.tgz"
$nativeName = "koromix-koffi-win32-x64-$koffiVersion.tgz"
$coreSha256 = '9da0daf695cfdabcdcb36f3e4d1e26456522d6c4efb53f114f83474cd5d35373'
$nativeSha256 = '53254aaefc38c53013793d915f557883412d297112898cac29f0cf81089cdd27'
$coreUrl = "https://registry.npmjs.org/koffi/-/koffi-$koffiVersion.tgz"
$nativeUrl = "https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-$koffiVersion.tgz"

if ([string]::IsNullOrWhiteSpace($SlotPath)) {
    $SlotPath = Join-Path $runtime (Join-Path 'slots' $SlotName)
}
$SlotPath = [System.IO.Path]::GetFullPath($SlotPath)
$nodeModules = Join-Path $SlotPath 'devspace\node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
    throw "Runtime slot dependency tree not found: $nodeModules"
}

function Test-Hash([string]$Path, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256)
}

function Get-VerifiedFile([string]$Url, [string]$Path, [string]$Sha256) {
    if (Test-Hash $Path $Sha256) { return }
    if ($NoDownload) { throw "Koffi cache missing or invalid: $Path" }
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $partial = $Path + '.partial'
    & curl.exe -L --fail --retry 12 --retry-delay 2 --connect-timeout 20 -C - --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Koffi download failed; partial file kept: $partial" }
    if (-not (Test-Hash $partial $Sha256)) { throw "Koffi SHA256 mismatch: $partial" }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

function Install-TarPackage([string]$Archive, [string]$Target) {
    $temp = Join-Path $cache ('extract-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $temp | Out-Null
    try {
        & tar.exe -xzf $Archive -C $temp
        if ($LASTEXITCODE -ne 0) { throw "Failed to extract $Archive" }
        $source = Join-Path $temp 'package'
        if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
            throw "Invalid npm package archive: $Archive"
        }
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force (Split-Path $Target) | Out-Null
        Move-Item -LiteralPath $source -Destination $Target
    }
    finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

New-Item -ItemType Directory -Force $cache | Out-Null
$core = Join-Path $cache $coreName
$native = Join-Path $cache $nativeName
Get-VerifiedFile $coreUrl $core $coreSha256
Get-VerifiedFile $nativeUrl $native $nativeSha256

Install-TarPackage $core (Join-Path $nodeModules 'koffi')
Install-TarPackage $native (Join-Path $nodeModules '@koromix\koffi-win32-x64')

$node = Join-Path $SlotPath 'node\node.exe'
$smoke = @'
import koffi from 'koffi';
const kernel32 = koffi.load('kernel32.dll');
const getCurrentProcessId = kernel32.func('uint32_t GetCurrentProcessId()');
const pid = getCurrentProcessId();
if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid Win32 PID from Koffi');
console.log(`koffi=${koffi.version} pid=${pid}`);
'@
Push-Location (Join-Path $SlotPath 'devspace')
try {
    & $node --input-type=module -e $smoke
    if ($LASTEXITCODE -ne 0) { throw 'Koffi Win32 smoke failed.' }
}
finally {
    Pop-Location
}

Write-Host "Koffi $koffiVersion ready in runtime slot: $SlotPath"
