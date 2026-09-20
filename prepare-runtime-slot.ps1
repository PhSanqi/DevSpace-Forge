param(
    [string]$SlotName = 'windows-beta4-local11',
    [switch]$NoDownload
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$slots = Join-Path $runtime 'slots'
$cache = Join-Path $runtime 'cache'
$slot = Join-Path $slots $SlotName
$preparing = $slot + '.preparing'
$nodeVersion = '22.22.3'
$nodeSha256 = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33'
$devSpaceVersion = '1.1.0-beta.4.local.11'
$devSpaceSha256 = '71b41c67175687b6042f8d0a75ef477134b1abe4ce10c1fa2889e48f40b9976b'
$assetName = 'waishnav-devspace-1.1.0-beta.4.local.11.tgz'
$assetUrl = 'https://github.com/PhSanqi/DevSpace-Forge/releases/download/runtime-1.1.0-beta.4.local.11/waishnav-devspace-1.1.0-beta.4.local.11.tgz'

function Assert-Hash([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Expected)
}

function Get-ResumableFile([string]$Url, [string]$Path, [string]$Sha256) {
    if (Assert-Hash $Path $Sha256) { return }
    if ($NoDownload) { throw "本地缓存不存在或校验失败：$Path" }
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $partial = $Path + '.partial'
    Write-Host "Downloading small runtime asset with resume support: $Url"
    & curl.exe -L --fail --retry 12 --retry-delay 2 --connect-timeout 20 -C - --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "下载失败；保留 partial 文件供下次续传：$partial" }
    if (-not (Assert-Hash $partial $Sha256)) { throw "下载完成但 SHA256 不匹配：$partial" }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

New-Item -ItemType Directory -Force $slots, $cache | Out-Null

$nodeZip = Join-Path $runtime "node-v$nodeVersion-win-x64.zip"
if (-not (Assert-Hash $nodeZip $nodeSha256)) {
    throw "Node 缓存 ZIP 缺失或校验失败。不会重新下载大文件：$nodeZip"
}

$asset = Join-Path $cache $assetName
Get-ResumableFile $assetUrl $asset $devSpaceSha256

Remove-Item -LiteralPath $preparing -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $preparing | Out-Null

try {
    Write-Host '1/4 Extract cached Node into isolated slot...'
    $nodeExtract = Join-Path $preparing '_node'
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
    $nodeSource = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
    if (-not (Test-Path -LiteralPath (Join-Path $nodeSource 'node.exe'))) { throw 'Node extraction incomplete.' }
    Move-Item -LiteralPath $nodeSource -Destination (Join-Path $preparing 'node')
    Remove-Item -LiteralPath $nodeExtract -Recurse -Force

    Write-Host '2/4 Reuse current dependency tree locally (no npm install)...'
    $legacyDevSpace = Join-Path $runtime 'devspace'
    if (-not (Test-Path -LiteralPath (Join-Path $legacyDevSpace 'node_modules'))) {
        throw "Existing dependency tree not found: $legacyDevSpace"
    }
    $stagedDevSpace = Join-Path $preparing 'devspace'
    New-Item -ItemType Directory -Force $stagedDevSpace | Out-Null
    # npm created this self-link while the old runtime was installed from the
    # ControlPlatform package root. Its historical target no longer exists and
    # it is not a DevSpace runtime dependency, so do not reproduce the broken
    # junction inside an otherwise self-contained slot.
    $brokenSelfLink = Join-Path $legacyDevSpace 'node_modules\devspace-control-platform-runtime'
    & robocopy.exe $legacyDevSpace $stagedDevSpace /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XD $brokenSelfLink /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy dependency reuse failed with code $LASTEXITCODE" }

    Write-Host '3/4 Replace only @waishnav/devspace with the verified local.11 unified package...'
    $extract = Join-Path $preparing '_package'
    New-Item -ItemType Directory -Force $extract | Out-Null
    & tar.exe -xzf $asset -C $extract
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract Windows DevSpace runtime package.' }
    $packageSource = Join-Path $extract 'package'
    $packageTarget = Join-Path $stagedDevSpace 'node_modules\@waishnav\devspace'
    Remove-Item -LiteralPath $packageTarget -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force (Split-Path $packageTarget) | Out-Null
    Move-Item -LiteralPath $packageSource -Destination $packageTarget
    Remove-Item -LiteralPath $extract -Recurse -Force

    $actualVersion = (Get-Content -Raw -LiteralPath (Join-Path $packageTarget 'package.json') | ConvertFrom-Json).version
    if ($actualVersion -ne $devSpaceVersion) { throw "Unexpected staged DevSpace version: $actualVersion" }

    Write-Host '4/5 Install pinned Koffi Win32 dependency...'
    $koffiArgs = @('-SlotPath', $preparing)
    if ($NoDownload) { $koffiArgs += '-NoDownload' }
    & (Join-Path $root 'setup-koffi.ps1') @koffiArgs
    if ($LASTEXITCODE -ne 0) { throw 'Koffi slot setup failed.' }

    Write-Host '5/5 Validate staged runtime without touching the active service...'
    $node = Join-Path $preparing 'node\node.exe'
    $cli = Join-Path $packageTarget 'dist\cli.js'
    $nodeActual = & $node --version
    $devSpaceActual = & $node $cli --version
    if ($LASTEXITCODE -ne 0 -or $devSpaceActual.Trim() -ne $devSpaceVersion) {
        throw "Staged DevSpace CLI validation failed: $devSpaceActual"
    }
    foreach ($required in @(
        'dist\context-intelligence.js',
        'dist\serena-semantic.js',
        'dist\mcp-modern-server.js',
        'dist\artifact-destination-windows.js'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageTarget $required))) { throw "Missing staged file: $required" }
    }

    $meta = [ordered]@{
        slot = $SlotName
        preparedAt = [DateTimeOffset]::Now.ToString('o')
        node = $nodeActual.Trim()
        devspace = $devSpaceActual.Trim()
        devspaceSha256 = $devSpaceSha256
        dependencies = 'reused-from-current-runtime+koffi-3.2.1-win32-x64'
        serena = 'optional-not-required-for-activation'
    }
    $meta | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $preparing 'slot.json') -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $preparing 'READY') -Value $devSpaceVersion -Encoding ASCII

    Remove-Item -LiteralPath $slot -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $preparing -Destination $slot
    Write-Host "Runtime slot ready: $slot"
    Write-Host "No active runtime was replaced. Current DevSpace was not stopped."
}
catch {
    Write-Host "Slot preparation failed; active runtime is unchanged." -ForegroundColor Yellow
    throw
}
