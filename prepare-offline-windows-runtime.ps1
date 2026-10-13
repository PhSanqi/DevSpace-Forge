param(
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,
    [Parameter(Mandatory = $true)]
    [string]$RuntimePackagePath,
    [string]$GitHubProxyPrefix = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$nodeVersion = '22.22.3'
$nodeSha256 = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33'
$cloudflaredVersion = '2026.9.1'
$cloudflaredSha256 = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712'
$devSpaceVersion = '1.1.0-beta.4.local.15'
$devSpacePackageName = 'waishnav-devspace-1.1.0-beta.4.local.15.tgz'
$slotName = 'windows-beta4-local15'

$root = $PSScriptRoot
$output = [IO.Path]::GetFullPath((Join-Path $root $OutputRoot))
$cache = Join-Path $root 'dist\.offline-cache\windows'
$runtime = Join-Path $output 'runtime'
$slot = Join-Path $runtime ('slots\' + $slotName)
$nodeDir = Join-Path $slot 'node'
$devspaceDir = Join-Path $slot 'devspace'
$cloudflared = Join-Path $output 'cloudflared.exe'

function Test-Hash([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Expected)
}

function Get-Verified([string]$Url, [string]$Path, [string]$Sha256) {
    if (Test-Hash $Path $Sha256) { return }
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $partial = $Path + '.partial'
    & curl.exe -L --fail --retry 12 --retry-delay 2 --connect-timeout 20 -C - --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    if (-not (Test-Hash $partial $Sha256)) { throw "SHA256 mismatch: $Url" }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

function Resolve-GitHubDownloadUrl([string]$Url) {
    if ([string]::IsNullOrWhiteSpace($GitHubProxyPrefix)) { return $Url }
    $uri = [Uri]$Url
    if ($uri.Host -ne 'github.com') { return $Url }
    $prefix = $GitHubProxyPrefix.TrimEnd('/')
    if (-not $prefix.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'GitHubProxyPrefix must be an https URL.'
    }
    return "$prefix/$Url"
}

if ($Force) { Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue }
if ((Test-Path -LiteralPath (Join-Path $slot 'READY')) -and
    (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) -and
    (Test-Path -LiteralPath (Join-Path $devspaceDir 'node_modules\@waishnav\devspace\package.json')) -and
    (Test-Path -LiteralPath $cloudflared)) {
    $existingVersion = (Get-Content -Raw (Join-Path $devspaceDir 'node_modules\@waishnav\devspace\package.json') | ConvertFrom-Json).version
    if ($existingVersion -eq $devSpaceVersion) {
        Write-Host "Offline Windows runtime already ready: $output"
        exit 0
    }
}

Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $cache, $slot, $devspaceDir | Out-Null

$nodeZip = Join-Path $cache "node-v$nodeVersion-win-x64.zip"
Get-Verified "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" $nodeZip $nodeSha256
$nodeExtract = Join-Path $output '.node-extract'
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
Move-Item -LiteralPath (Join-Path $nodeExtract "node-v$nodeVersion-win-x64") -Destination $nodeDir
Remove-Item -LiteralPath $nodeExtract -Recurse -Force

$cloudflaredCache = Join-Path $cache "cloudflared-$cloudflaredVersion-windows-amd64.exe"
Get-Verified `
    (Resolve-GitHubDownloadUrl "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe") `
    $cloudflaredCache `
    $cloudflaredSha256
Copy-Item -LiteralPath $cloudflaredCache -Destination $cloudflared -Force

$runtimePackage = if ([IO.Path]::IsPathRooted($RuntimePackagePath)) {
    [IO.Path]::GetFullPath($RuntimePackagePath)
} else {
    [IO.Path]::GetFullPath((Join-Path $root $RuntimePackagePath))
}
if (-not (Test-Path -LiteralPath $runtimePackage)) {
    throw "Canonical DevSpace runtime package was not found: $runtimePackage"
}
Write-Host ("Canonical DevSpace runtime package SHA256: " + (Get-FileHash -LiteralPath $runtimePackage -Algorithm SHA256).Hash.ToLowerInvariant())
Copy-Item -LiteralPath $runtimePackage -Destination (Join-Path $devspaceDir 'devspace-runtime.tgz') -Force

@'
{
  "private": true,
  "name": "devspace-control-platform-offline-runtime",
  "dependencies": {
    "@waishnav/devspace": "file:devspace-runtime.tgz"
  }
}
'@ | Set-Content -LiteralPath (Join-Path $devspaceDir 'package.json') -Encoding UTF8

$node = Join-Path $nodeDir 'node.exe'
$npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
$systemNpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$systemNpmCli = if ($systemNpmCommand) {
    Join-Path (Split-Path $systemNpmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
} else {
    ''
}
$previousPath = $env:PATH
$dependenciesAlreadyPruned = $false
try {
    $env:PATH = "$nodeDir;$previousPath"
    & $node $npmCli --version *> $null
    $bundledNpmReady = $LASTEXITCODE -eq 0
    if ($bundledNpmReady) {
        Push-Location $devspaceDir
        try {
            & $node $npmCli install --omit=dev --no-fund --no-audit
            $npmExitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        if ($npmExitCode -ne 0) { throw "npm install failed with code $npmExitCode" }
    }
    else {
        if ([string]::IsNullOrWhiteSpace($systemNpmCli) -or -not (Test-Path -LiteralPath $systemNpmCli)) {
            throw 'Bundled npm could not start and no system npm CLI fallback was found.'
        }
        & $node $systemNpmCli --version *> $null
        if ($LASTEXITCODE -ne 0) {
            throw 'Bundled npm could not start and the system npm CLI fallback is incompatible with the bundled Node.'
        }

        # Some Windows installations cannot spawn dependency lifecycle scripts when
        # npm's working directory is nested under the long release staging path.
        # Keep the target Node/ABI, but perform only this fallback install in a short
        # temporary directory before copying the complete dependency tree into place.
        $fallbackRoot = Join-Path ([IO.Path]::GetTempPath()) ('devspace-runtime-npm-' + [Guid]::NewGuid().ToString('N'))
        Write-Host 'Bundled npm could not start; using the system npm CLI with the bundled Node in a short staging path.'
        New-Item -ItemType Directory -Force $fallbackRoot | Out-Null
        try {
            Copy-Item -LiteralPath (Join-Path $devspaceDir 'package.json') -Destination $fallbackRoot -Force
            Copy-Item -LiteralPath (Join-Path $devspaceDir 'devspace-runtime.tgz') -Destination $fallbackRoot -Force
            Push-Location $fallbackRoot
            try {
                & $node $systemNpmCli install --omit=dev --no-fund --no-audit
                $npmExitCode = $LASTEXITCODE
            }
            finally {
                Pop-Location
            }
            if ($npmExitCode -ne 0) { throw "npm install failed with code $npmExitCode" }

            $fallbackNodeModules = Join-Path $fallbackRoot 'node_modules'
            $targetNodeModules = Join-Path $devspaceDir 'node_modules'
            if (-not (Test-Path -LiteralPath $fallbackNodeModules -PathType Container)) {
                throw 'npm fallback completed without producing node_modules.'
            }
            $copyArgs = @(
                $fallbackNodeModules,
                $targetNodeModules,
                '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/MT:16',
                '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
                '/XF', '*.map', '*.d.ts', '*.pdb'
            )
            $fallbackAnthropic = Join-Path $fallbackNodeModules '@anthropic-ai'
            if (Test-Path -LiteralPath $fallbackAnthropic) {
                $claudeSdkDirs = @(Get-ChildItem -LiteralPath $fallbackAnthropic -Directory -Filter 'claude-agent-sdk*' -ErrorAction SilentlyContinue)
                if ($claudeSdkDirs.Count -gt 0) {
                    $copyArgs += '/XD'
                    $copyArgs += @($claudeSdkDirs | ForEach-Object { $_.FullName })
                }
            }
            & robocopy.exe @copyArgs | Out-Null
            $copyExitCode = $LASTEXITCODE
            if ($copyExitCode -ge 8) { throw "npm fallback dependency copy failed with code $copyExitCode" }
            $dependenciesAlreadyPruned = $true
            $fallbackLock = Join-Path $fallbackRoot 'package-lock.json'
            if (Test-Path -LiteralPath $fallbackLock) {
                Copy-Item -LiteralPath $fallbackLock -Destination (Join-Path $devspaceDir 'package-lock.json') -Force
            }
        }
        finally {
            Remove-Item -LiteralPath $fallbackRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    $env:PATH = $previousPath
}

$controlRuntimeLink = Join-Path $devspaceDir 'node_modules\devspace-control-platform-runtime'
if (Test-Path -LiteralPath $controlRuntimeLink) {
    throw 'Offline runtime installation unexpectedly linked the Control repository into node_modules.'
}

# DevSpaceControl keeps subagents disabled. The Claude Agent SDK is therefore a
# dormant provider dependency here, and its Windows payload alone is hundreds
# of MiB. Remove it from the Control runtime together with build/debug metadata
# that Node does not need at runtime. Keep pi-coding-agent because core
# workspace/skills code imports it directly.
$nodeModules = Join-Path $devspaceDir 'node_modules'
if (-not $dependenciesAlreadyPruned) {
    Get-ChildItem -LiteralPath $nodeModules -Recurse -File -Force | ForEach-Object {
        $name = $_.Name.ToLowerInvariant()
        if ($name.EndsWith('.map') -or $name.EndsWith('.d.ts') -or $name.EndsWith('.pdb')) {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }
    $anthropicModules = Join-Path $nodeModules '@anthropic-ai'
    if (Test-Path -LiteralPath $anthropicModules) {
        Get-ChildItem -LiteralPath $anthropicModules -Directory -Filter 'claude-agent-sdk*' -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force
    }
}

$installed = Join-Path $devspaceDir 'node_modules\@waishnav\devspace\package.json'
if (-not (Test-Path -LiteralPath $installed)) { throw 'DevSpace offline runtime installation failed.' }
$actualVersion = (Get-Content -Raw $installed | ConvertFrom-Json).version
if ($actualVersion -ne $devSpaceVersion) { throw "Unexpected DevSpace version: $actualVersion" }

$devSpacePackageRoot = Split-Path -Parent $installed
$videoCache = Join-Path $root 'dist\.offline-cache\video'
New-Item -ItemType Directory -Force $videoCache | Out-Null
$videoSidecarArgs = @(
    (Join-Path $root 'ops\prepare-video-sidecar.mjs'),
    '--platform', 'win32-x64',
    '--target', $devSpacePackageRoot,
    '--cache', $videoCache
)
if (-not [string]::IsNullOrWhiteSpace($GitHubProxyPrefix)) {
    $videoSidecarArgs += @('--github-proxy-prefix', $GitHubProxyPrefix)
}
& $node @videoSidecarArgs
if ($LASTEXITCODE -ne 0) { throw 'Windows video sidecar preparation failed.' }
& $node (Join-Path $root 'ops\video-sidecar-runtime-smoke.mjs') `
    --package-root $devSpacePackageRoot
if ($LASTEXITCODE -ne 0) { throw 'Windows video sidecar runtime smoke failed.' }

Push-Location $devspaceDir
try {
    & $node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.prepare('select 1 as ok').get(); db.close(); console.log('Windows bundle better-sqlite3: ok');"
    if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 Windows native smoke failed.' }

    & $node --input-type=module -e "import koffi from 'koffi'; const k=koffi.load('kernel32.dll'); const f=k.func('uint32_t GetCurrentProcessId()'); if(f()<=0) process.exit(2);"
    if ($LASTEXITCODE -ne 0) { throw 'Koffi Windows native smoke failed.' }

    & $node --input-type=module -e "import sharp from 'sharp'; const b=await sharp({create:{width:4,height:4,channels:3,background:'#fff'}}).jpeg().toBuffer(); if(!b.length) process.exit(2); console.log('Windows bundle sharp: '+sharp.versions.sharp);"
    if ($LASTEXITCODE -ne 0) { throw 'Sharp Windows native smoke failed.' }
}
finally { Pop-Location }

$nodeActual = & $node --version
if ($nodeActual -ne "v$nodeVersion") { throw "Unexpected Node version: $nodeActual" }
$cfActual = & $cloudflared --version
if ($LASTEXITCODE -ne 0 -or $cfActual -notmatch [regex]::Escape($cloudflaredVersion)) { throw "Unexpected cloudflared version: $cfActual" }

$runtimeFiles = Get-ChildItem -LiteralPath $slot -Recurse -File -Force
Write-Host ("Pruned Windows runtime: {0:N1} MiB / {1:N0} files" -f (($runtimeFiles | Measure-Object Length -Sum).Sum / 1MB), $runtimeFiles.Count)

Set-Content -LiteralPath (Join-Path $slot 'READY') -Encoding ASCII -Value $devSpaceVersion
$slotMetadata = @{
    slot = $slotName
    platform = 'windows-x64'
    node = $nodeVersion
    devspace = $devSpaceVersion
    cloudflared = $cloudflaredVersion
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $slot 'slot.json') -Encoding UTF8 -Value $slotMetadata
New-Item -ItemType Directory -Force $runtime | Out-Null
Set-Content -LiteralPath (Join-Path $runtime 'active-slot.txt') -Encoding ASCII -Value $slotName

Write-Host "Offline Windows runtime ready: $output"
exit 0
