param(
    [switch]$Force,
    [switch]$WithSerena
)

$ErrorActionPreference = 'Stop'
$nodeVersion = '22.22.3'
$nodeSha256 = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33'
$cloudflaredVersion = '2026.9.1'
$cloudflaredSha256 = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712'
$devSpaceVersion = '1.1.0-beta.4.local.10'
$devSpaceRuntimeTag = 'runtime-1.1.0-beta.4.local.10'
$devSpacePackageName = 'waishnav-devspace-1.1.0-beta.4.local.10.tgz'
$devSpacePackageSha256 = '4516d348af6ebc149dbc30a0fdce75b746b5c0dbfd6ed8415c38e7435b07124a'

$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$cache = Join-Path $runtime 'cache'
$nodeDir = Join-Path $runtime "node-v$nodeVersion-win-x64"
$devspaceDir = Join-Path $runtime 'devspace'
$cloudflared = Join-Path $root 'cloudflared.exe'

function Test-Hash([string]$Path, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256)
}

function Get-VerifiedFile([string]$Url, [string]$Path, [string]$Sha256) {
    if (Test-Hash $Path $Sha256) { return }
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $partial = $Path + '.partial'
    Write-Host "Downloading: $Url"
    & curl.exe -L --fail --retry 12 --retry-delay 2 --connect-timeout 20 -C - --output $partial $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed. Partial data was kept for retry: $partial"
    }
    $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "SHA256 mismatch for $Url. Expected $Sha256, got $actual." }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

function Assert-NodeRuntimeNotInUse([string]$NodeExe) {
    if (-not (Test-Path -LiteralPath $NodeExe)) { return }
    $nodeFull = [System.IO.Path]::GetFullPath($NodeExe)
    $users = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and [string]::Equals(
            [System.IO.Path]::GetFullPath($_.ExecutablePath),
            $nodeFull,
            [StringComparison]::OrdinalIgnoreCase)
    })
    if ($users.Count -gt 0) {
        $pids = ($users | ForEach-Object { $_.ProcessId }) -join ', '
        throw "Node runtime is currently in use by PID(s) $pids. In-place replacement is intentionally blocked. Run prepare-runtime-slot.ps1 while DevSpace stays online, validate it with test-runtime-slot.ps1, then use activate-runtime-slot.ps1 for the cutover."
    }
}

New-Item -ItemType Directory -Force $runtime, $cache, $devspaceDir | Out-Null

if ($Force) {
    Assert-NodeRuntimeNotInUse (Join-Path $nodeDir 'node.exe')
}

# Reuse the large Node ZIP from older installs instead of downloading it again.
$legacyNodeZip = Join-Path $runtime "node-v$nodeVersion-win-x64.zip"
$nodeZip = Join-Path $cache "node-v$nodeVersion-win-x64.zip"
if (-not (Test-Hash $nodeZip $nodeSha256) -and (Test-Hash $legacyNodeZip $nodeSha256)) {
    Copy-Item -LiteralPath $legacyNodeZip -Destination $nodeZip -Force
}
Get-VerifiedFile "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" $nodeZip $nodeSha256

if ($Force -or -not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
    Assert-NodeRuntimeNotInUse (Join-Path $nodeDir 'node.exe')
    Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
    $extract = Join-Path $runtime '.node-extract'
    Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $extract -Force
    Move-Item -LiteralPath (Join-Path $extract "node-v$nodeVersion-win-x64") -Destination $nodeDir
    Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
}

Get-VerifiedFile `
    "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe" `
    $cloudflared $cloudflaredSha256

$cachedDevSpacePackage = Join-Path $cache $devSpacePackageName
Get-VerifiedFile `
    "https://github.com/PhSanqi/DevSpaceControlPlatform/releases/download/$devSpaceRuntimeTag/$devSpacePackageName" `
    $cachedDevSpacePackage $devSpacePackageSha256
$devSpacePackage = Join-Path $devspaceDir $devSpacePackageName
Copy-Item -LiteralPath $cachedDevSpacePackage -Destination $devSpacePackage -Force

if ($Force) {
    Remove-Item -LiteralPath (Join-Path $devspaceDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $devspaceDir 'package.json') -Force
Remove-Item -LiteralPath (Join-Path $devspaceDir 'package-lock.json') -Force -ErrorAction SilentlyContinue
& (Join-Path $nodeDir 'npm.cmd') install --omit=dev --no-fund --prefix $devspaceDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$installedPackage = Join-Path $devspaceDir 'node_modules\@waishnav\devspace\package.json'
if (-not (Test-Path -LiteralPath $installedPackage)) { throw 'DevSpace package was not installed.' }
$installedVersion = (Get-Content -Raw -LiteralPath $installedPackage | ConvertFrom-Json).version
if ($installedVersion -ne $devSpaceVersion) {
    throw "Unexpected DevSpace version. Expected $devSpaceVersion, got $installedVersion."
}

$nodeActual = & (Join-Path $nodeDir 'node.exe') --version
if ($nodeActual -ne "v$nodeVersion") { throw "Unexpected Node version: $nodeActual" }
$cloudflaredActual = & $cloudflared --version
if ($LASTEXITCODE -ne 0 -or $cloudflaredActual -notmatch [regex]::Escape($cloudflaredVersion)) {
    throw "Unexpected cloudflared version: $cloudflaredActual"
}

Write-Host "Core runtime ready: Node $nodeVersion, DevSpace $devSpaceVersion, cloudflared $cloudflaredVersion."
Write-Host "Verified archives remain cached under $cache; -Force no longer redownloads valid files."

if ($WithSerena) {
    & (Join-Path $root 'setup-serena.ps1') -Force:$Force
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host 'Serena was not changed. It is optional for core activation; run setup-serena.ps1 separately when network access is reliable.'
}
