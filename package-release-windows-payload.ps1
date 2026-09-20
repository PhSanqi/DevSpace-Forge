param(
    [string]$Version = '0.3.0',
    [Parameter(Mandatory = $true)]
    [string]$RuntimePayloadPath
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$packageName = "DevSpaceControlPlatform-v$Version-win-x64"
$stage = Join-Path $dist $packageName
$zip = Join-Path $dist "$packageName.zip"
$hashFile = $zip + '.sha256.txt'

$payload = if ([IO.Path]::IsPathRooted($RuntimePayloadPath)) {
    [IO.Path]::GetFullPath($RuntimePayloadPath)
} else {
    [IO.Path]::GetFullPath((Join-Path $root $RuntimePayloadPath))
}
if (-not (Test-Path -LiteralPath $payload)) { throw "Windows runtime payload was not found: $payload" }

Write-Host '[windows-release] validating payload contents'
$entries = @(& tar.exe -tf $payload)
if ($LASTEXITCODE -ne 0) { throw 'Windows runtime payload is not a readable tar archive.' }
$required = @(
    'runtime/active-slot.txt',
    'runtime/slots/windows-beta4-local11/READY',
    'runtime/slots/windows-beta4-local11/node/node.exe',
    'runtime/slots/windows-beta4-local11/devspace/node_modules/@waishnav/devspace/package.json',
    'cloudflared.exe'
)
foreach ($item in $required) {
    if ($entries -notcontains $item) { throw "Windows runtime payload is missing: $item" }
}

Write-Host '[windows-release] running Control tests'
& (Join-Path $root 'test.ps1') -SkipRuntimeSmoke
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $dist | Out-Null
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip, $hashFile -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage 'payload') | Out-Null

& (Join-Path $root 'build.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'DevSpaceControlPlatform.exe'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $root 'build-setup.ps1') -OutputPath (Join-Path 'dist' (Join-Path $packageName 'Setup.exe'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item -LiteralPath $payload -Destination (Join-Path $stage 'payload\runtime.tar') -Force
foreach ($file in @('README.md', 'README.zh-CN.md', 'LICENSE')) {
    Copy-Item (Join-Path $root $file) $stage -Force
}

$sevenZip = $null
$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($sevenZipCommand) { $sevenZip = $sevenZipCommand.Source }
if (-not $sevenZip) {
    $candidate = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
    if (Test-Path -LiteralPath $candidate) { $sevenZip = $candidate }
}

Write-Host '[windows-release] creating final ZIP from single runtime payload'
if ($sevenZip) {
    Push-Location $dist
    try {
        & $sevenZip a -tzip -mx=1 -mmt=on -bd -bb0 (Split-Path $zip -Leaf) $packageName
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & $sevenZip t -bd -bb0 $zip
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally { Pop-Location }
}
else {
    Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Fastest
}

$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
Set-Content -Path $hashFile -Encoding ASCII -Value "$hash  $packageName.zip"
Write-Host "Created $zip"
Write-Host "SHA256 $hash"
