param(
    [string]$Version = '0.6.1',
    [Parameter(Mandatory = $true)]
    [string]$RuntimePayloadPath
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$packageName = "DevSpace-Forge-v$Version-win-x64"
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
    'runtime/slots/windows-beta4-local13/READY',
    'runtime/slots/windows-beta4-local13/node/node.exe',
    'runtime/slots/windows-beta4-local13/devspace/node_modules/@waishnav/devspace/package.json',
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
New-Item -ItemType Directory -Force (Join-Path $stage 'ops') | Out-Null
foreach ($file in @('runtime-console.mjs', 'runtime-rollback.mjs', 'control-management.mjs', 'runtime-console-ui.html', 'runtime-console-ui.css', 'runtime-console-ui.js', 'start-runtime-console.ps1')) {
    Copy-Item (Join-Path $root ('ops\' + $file)) (Join-Path $stage 'ops') -Force
}
& node (Join-Path $root 'ops\write-provenance.mjs') --source-root $root --server-file (Join-Path $stage 'ops\runtime-console.mjs') --ui-dir (Join-Path $stage 'ops') --package-file (Join-Path $root 'package.json') --output (Join-Path $stage 'control-provenance.json') --version $Version --artifact-id $packageName --strict
if ($LASTEXITCODE -ne 0) { throw 'Control provenance generation failed.' }
Copy-Item (Join-Path $root 'update-control-platform-out-of-band.ps1') $stage -Force

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
