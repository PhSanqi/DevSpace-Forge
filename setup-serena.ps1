param([switch]$Force)

$ErrorActionPreference = 'Stop'
$uvVersion = '0.12.15'
$uvSha256 = '477bd99a84e34891f2bd4c9152ddeb74e971accccbc59c0f0301f11f08a32d46'
$uvAssetId = '565630896'
$serenaVersion = '1.7.0'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$cache = Join-Path $runtime 'cache'
$uvDir = Join-Path $runtime 'uv'
$uvExe = Join-Path $uvDir 'uv.exe'
$uvZip = Join-Path $cache "uv-$uvVersion-x86_64-pc-windows-msvc.zip"
$serenaRoot = Join-Path $runtime 'serena'
$serenaBin = Join-Path $serenaRoot 'bin'
$serenaToolDir = Join-Path $serenaRoot 'tools'
$serenaPythonDir = Join-Path $serenaRoot 'python'
$serenaExe = Join-Path $serenaBin 'serena.exe'
$uvCacheDir = Join-Path $cache 'uv-cache'

function Test-Hash([string]$Path, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256)
}

function Get-VerifiedFile([string]$Url, [string]$Path, [string]$Sha256) {
    if (Test-Hash $Path $Sha256) { return }
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $partial = $Path + '.partial'
    & curl.exe -L --fail --retry 20 --retry-all-errors --retry-delay 2 --connect-timeout 20 -C - `
        -H "Accept: application/octet-stream" -H "User-Agent: DevSpaceControlPlatform" `
        --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "uv download failed; partial file was kept for retry: $partial" }
    $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "uv SHA256 mismatch. Expected $Sha256, got $actual." }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

New-Item -ItemType Directory -Force $runtime, $cache | Out-Null
Get-VerifiedFile "https://api.github.com/repos/astral-sh/uv/releases/assets/$uvAssetId" $uvZip $uvSha256

if ($Force -or -not (Test-Path -LiteralPath $uvExe)) {
    Remove-Item -LiteralPath $uvDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $uvDir | Out-Null
    Expand-Archive -LiteralPath $uvZip -DestinationPath $uvDir -Force
}
if (-not (Test-Path -LiteralPath $uvExe)) { throw "uv.exe was not installed at $uvExe" }

$installSerena = $Force -or -not (Test-Path -LiteralPath $serenaExe)
if (-not $installSerena) {
    $current = (& $serenaExe --version 2>$null | Out-String).Trim()
    $installSerena = $LASTEXITCODE -ne 0 -or $current -notmatch [regex]::Escape($serenaVersion)
}

if ($installSerena) {
    New-Item -ItemType Directory -Force $serenaBin, $serenaToolDir, $serenaPythonDir | Out-Null
    $oldToolBin = $env:UV_TOOL_BIN_DIR
    $oldToolDir = $env:UV_TOOL_DIR
    $oldPythonDir = $env:UV_PYTHON_INSTALL_DIR
    $oldCacheDir = $env:UV_CACHE_DIR
    try {
        $env:UV_TOOL_BIN_DIR = $serenaBin
        $env:UV_TOOL_DIR = $serenaToolDir
        $env:UV_PYTHON_INSTALL_DIR = $serenaPythonDir
        $env:UV_CACHE_DIR = $uvCacheDir
        & $uvExe tool install --force --python 3.13 "serena-agent==$serenaVersion"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        $env:UV_TOOL_BIN_DIR = $oldToolBin
        $env:UV_TOOL_DIR = $oldToolDir
        $env:UV_PYTHON_INSTALL_DIR = $oldPythonDir
        $env:UV_CACHE_DIR = $oldCacheDir
    }
}

if (-not (Test-Path -LiteralPath $serenaExe)) { throw "Serena CLI was not installed at $serenaExe" }
$serenaActual = (& $serenaExe --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $serenaActual -notmatch [regex]::Escape($serenaVersion)) {
    throw "Unexpected Serena version: $serenaActual"
}
Write-Host "Serena ready: $serenaActual (uv $uvVersion)."
