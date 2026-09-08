param([switch]$Force)

$ErrorActionPreference = 'Stop'
$nodeVersion = '22.22.3'
$nodeSha256 = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33'
$cloudflaredVersion = '2026.8.2'
$cloudflaredSha256 = 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5'
$devSpaceVersion = '1.1.0-beta.1'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$nodeDir = Join-Path $runtime "node-v$nodeVersion-win-x64"
$devspaceDir = Join-Path $runtime 'devspace'
$cloudflared = Join-Path $root 'cloudflared.exe'

function Get-VerifiedFile($Url, $Path, $Sha256) {
    if ((Test-Path $Path) -and -not $Force) {
        $existing = (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLowerInvariant()
        if ($existing -eq $Sha256) { return }
    }

    $temp = $Path + '.download'
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
    & curl.exe -L --fail --retry 3 --output $temp $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    $actual = (Get-FileHash -Algorithm SHA256 $temp).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
        Remove-Item $temp -Force -ErrorAction SilentlyContinue
        throw "SHA256 mismatch for $Url. Expected $Sha256, got $actual."
    }
    Move-Item $temp $Path -Force
}

New-Item -ItemType Directory -Force $runtime, $devspaceDir | Out-Null

$nodeZip = Join-Path $runtime "node-v$nodeVersion-win-x64.zip"
Get-VerifiedFile "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" $nodeZip $nodeSha256
if ($Force -or -not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $nodeZip -DestinationPath $runtime -Force
}

Get-VerifiedFile `
    "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe" `
    $cloudflared $cloudflaredSha256

if ($Force) {
    Remove-Item (Join-Path $devspaceDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item (Join-Path $root 'package.json') (Join-Path $devspaceDir 'package.json') -Force
Remove-Item (Join-Path $devspaceDir 'package-lock.json') -Force -ErrorAction SilentlyContinue
& (Join-Path $nodeDir 'npm.cmd') install --omit=dev --no-fund --prefix $devspaceDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$installedPackage = Join-Path $devspaceDir 'node_modules\@waishnav\devspace\package.json'
if (-not (Test-Path $installedPackage)) { throw 'DevSpace package was not installed.' }
$installedVersion = (Get-Content $installedPackage -Raw | ConvertFrom-Json).version
if ($installedVersion -ne $devSpaceVersion) {
    throw "Unexpected DevSpace version. Expected $devSpaceVersion, got $installedVersion."
}

$nodeActual = & (Join-Path $nodeDir 'node.exe') --version
if ($nodeActual -ne "v$nodeVersion") { throw "Unexpected Node version: $nodeActual" }
$cloudflaredActual = & $cloudflared --version
if ($LASTEXITCODE -ne 0 -or $cloudflaredActual -notmatch [regex]::Escape($cloudflaredVersion)) {
    throw "Unexpected cloudflared version: $cloudflaredActual"
}

Remove-Item $nodeZip -Force
Write-Host "Runtime ready: Node $nodeVersion, DevSpace $devSpaceVersion, cloudflared $cloudflaredVersion."
