param(
    [string]$Version = '0.3.0',
    [string]$RuntimeBundleRoot,
    [ValidateSet('All', 'Validate', 'Stage', 'Archive')]
    [string]$Phase = 'All'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$packageName = "DevSpaceControlPlatform-v$Version-win-x64"
$stage = Join-Path $dist $packageName
$zip = Join-Path $dist "$packageName.zip"
$hashFile = $zip + '.sha256.txt'

if ([string]::IsNullOrWhiteSpace($RuntimeBundleRoot)) {
    $RuntimeBundleRoot = $root
}
$bundleRoot = if ([IO.Path]::IsPathRooted($RuntimeBundleRoot)) {
    [IO.Path]::GetFullPath($RuntimeBundleRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $root $RuntimeBundleRoot))
}
$bundleRuntime = Join-Path $bundleRoot 'runtime'
$bundleCloudflared = Join-Path $bundleRoot 'cloudflared.exe'
if (-not (Test-Path -LiteralPath (Join-Path $bundleRuntime 'active-slot.txt'))) {
    throw "Offline runtime bundle is missing active-slot.txt: $bundleRuntime"
}
$slotName = (Get-Content -Raw (Join-Path $bundleRuntime 'active-slot.txt')).Trim()
$slot = Join-Path $bundleRuntime ('slots\' + $slotName)
if (-not (Test-Path -LiteralPath (Join-Path $slot 'READY'))) { throw "Offline runtime slot is not READY: $slot" }
if (-not (Test-Path -LiteralPath (Join-Path $slot 'node\node.exe'))) { throw 'Offline Node.js runtime is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $slot 'devspace\node_modules\@waishnav\devspace\package.json'))) { throw 'Offline DevSpace runtime is missing.' }
if (-not (Test-Path -LiteralPath $bundleCloudflared)) { throw 'Offline cloudflared.exe is missing.' }

$sevenZip = $null
$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($sevenZipCommand) { $sevenZip = $sevenZipCommand.Source }
if (-not $sevenZip) {
    $candidate = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
    if (Test-Path -LiteralPath $candidate) { $sevenZip = $candidate }
}

if ($Phase -in @('All', 'Validate')) {
    Write-Host '[windows-release] validating tests and runtime smoke'
    & (Join-Path $root 'test.ps1') `
        -NodePath (Join-Path $slot 'node\node.exe') `
        -DevSpacePackageRoot (Join-Path $slot 'devspace\node_modules\@waishnav\devspace')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host '[windows-release] validation complete'
}

if ($Phase -in @('All', 'Stage')) {
    Write-Host '[windows-release] staging executables and documentation'
    New-Item -ItemType Directory -Force $dist | Out-Null
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip, $hashFile -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $stage | Out-Null

    & (Join-Path $root 'build.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'DevSpaceControlPlatform.exe'))
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & (Join-Path $root 'build-setup.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'Setup.exe'))
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    foreach ($file in @('README.md', 'README.zh-CN.md', 'LICENSE')) {
        Copy-Item (Join-Path $root $file) $stage -Force
    }

    # Developer fallback only. GitHub-hosted Windows runners have 7-Zip and the
    # archive phase reads the runtime directly from $bundleRoot, avoiding a full
    # duplicate copy of node_modules on the runner disk.
    if (-not $sevenZip) {
        Write-Warning '7-Zip was not found; staging expanded runtime for Compress-Archive fallback.'
        New-Item -ItemType Directory -Force (Join-Path $stage 'runtime\slots') | Out-Null
        Set-Content -LiteralPath (Join-Path $stage 'runtime\active-slot.txt') -Encoding ASCII -Value $slotName
        $stageSlot = Join-Path $stage ('runtime\slots\' + $slotName)
        New-Item -ItemType Directory -Force $stageSlot | Out-Null
        & robocopy.exe $slot $stageSlot /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /MT:16 /NFL /NDL /NJH /NJS /NP
        $robocopyExit = $LASTEXITCODE
        if ($robocopyExit -ge 8) { throw "Runtime copy failed with robocopy exit code $robocopyExit." }
        Copy-Item -LiteralPath $bundleCloudflared -Destination (Join-Path $stage 'cloudflared.exe') -Force
    }

    $stageVersion = (Get-Content -Raw (Join-Path $slot 'devspace\node_modules\@waishnav\devspace\package.json') | ConvertFrom-Json).version
    Write-Host "Windows bundle runtime: $stageVersion ($slotName)"
    Write-Host '[windows-release] staging complete'
}

if ($Phase -in @('All', 'Archive')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'Setup.exe'))) {
        throw "Windows release stage is missing Setup.exe: $stage"
    }

    Write-Host '[windows-release] creating final ZIP'
    Remove-Item $zip, $hashFile -Force -ErrorAction SilentlyContinue

    if ($sevenZip) {
        # Archive the runtime straight from the validated bundle. This avoids
        # copying ~650 MiB / tens of thousands of node_modules files into a
        # second staging tree before ZIP creation.
        Push-Location $bundleRoot
        try {
            & $sevenZip a -tzip -mx=0 -mmt=on -bd -bb0 $zip 'runtime' 'cloudflared.exe'
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        finally { Pop-Location }

        Push-Location $stage
        try {
            & $sevenZip a -tzip -mx=0 -mmt=on -bd -bb0 $zip `
                'DevSpaceControlPlatform.exe' 'Setup.exe' 'README.md' 'README.zh-CN.md' 'LICENSE'
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            & $sevenZip t -bd -bb0 $zip
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        finally { Pop-Location }
    }
    else {
        Write-Warning '7-Zip was not found; falling back to Compress-Archive.'
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Fastest
    }

    $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    Set-Content -Path $hashFile -Encoding ASCII -Value "$hash  $packageName.zip"
    Write-Host "Created $zip"
    Write-Host "SHA256 $hash"
    Write-Host '[windows-release] archive complete'
}
