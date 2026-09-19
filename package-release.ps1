param(
    [string]$Version = '0.3.0',
    [string]$RuntimeBundleRoot
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

& (Join-Path $root 'test.ps1') `
    -NodePath (Join-Path $slot 'node\node.exe') `
    -DevSpacePackageRoot (Join-Path $slot 'devspace\node_modules\@waishnav\devspace')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $dist | Out-Null
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip, $hashFile -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

& (Join-Path $root 'build.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'DevSpaceControlPlatform.exe'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $root 'build-setup.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'Setup.exe'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force (Join-Path $stage 'payload') | Out-Null
$payloadTar = Join-Path $stage 'payload\runtime.tar'
Push-Location $bundleRoot
try {
    & tar.exe -cf $payloadTar `
        'runtime/active-slot.txt' `
        ("runtime/slots/" + $slotName) `
        'cloudflared.exe'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally { Pop-Location }
foreach ($file in @('README.md', 'README.zh-CN.md', 'LICENSE')) {
    Copy-Item (Join-Path $root $file) $stage -Force
}

$stageVersion = (Get-Content -Raw (Join-Path $slot 'devspace\node_modules\@waishnav\devspace\package.json') | ConvertFrom-Json).version
Write-Host "Windows bundle runtime: $stageVersion ($slotName)"
Write-Host ("Runtime payload: {0:N1} MiB" -f ((Get-Item $payloadTar).Length / 1MB))

Push-Location $dist
try {
    & tar.exe -a -cf (Split-Path $zip -Leaf) $packageName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally { Pop-Location }
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
Set-Content -Path $hashFile -Encoding ASCII -Value "$hash  $packageName.zip"
Write-Host "Created $zip"
Write-Host "SHA256 $hash"
