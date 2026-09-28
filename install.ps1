param(
    [switch]$WithSerena
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host 'Installing DevSpace, Node.js and cloudflared...'
& (Join-Path $root 'setup-runtime.ps1') -WithSerena:$WithSerena
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $root 'DevSpaceControlPlatform.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "DevSpaceControlPlatform.exe was not found in the release directory: $exe"
}

Write-Host 'Runtime installation completed. Starting DevSpace Control Platform...'
Start-Process -FilePath $exe -WorkingDirectory $root

Write-Host ''
Write-Host 'Next: add your allowed project roots, then paste the Cloudflare Remote Tunnel hostname and token in the app.'
Write-Host 'Everything else required by the Windows runtime is installed locally by this script.'
