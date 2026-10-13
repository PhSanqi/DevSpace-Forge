param(
    [switch]$WithSerena
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host 'Installing DevSpace, Node.js and cloudflared...'
& (Join-Path $root 'setup-runtime.ps1') -WithSerena:$WithSerena
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$launcher = Join-Path $root 'ops\start-modern-desktop.ps1'
$desktop = Join-Path $root 'desktop\DevSpaceForgeDesktop.exe'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Modern desktop launcher was not found in the release directory: $launcher"
}
if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) {
    throw "DevSpaceForgeDesktop.exe was not found in the release directory: $desktop"
}

Write-Host 'Runtime installation completed. Starting DevSpace-Forge Desktop...'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -PlatformRoot "' + $root + '"'
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden

Write-Host ''
Write-Host 'Next: add your allowed project roots, then paste the Cloudflare Remote Tunnel hostname and token in the app.'
Write-Host 'Everything else required by the Windows runtime is installed locally by this script.'
