$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# The offline release is installed by the supported Setup wizard.
$setup = Join-Path $root 'Setup.exe'
if (Test-Path -LiteralPath $setup -PathType Leaf) {
    $setupProcess = Start-Process -FilePath $setup -WorkingDirectory $root -Wait -PassThru
    exit $setupProcess.ExitCode
}

$launcher = Join-Path $root 'ops\start-modern-desktop.ps1'
$desktop = Join-Path $root 'desktop\DevSpaceForgeDesktop.exe'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Modern desktop launcher was not found in the release directory: $launcher"
}
if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) {
    throw "DevSpaceForgeDesktop.exe was not found in the release directory: $desktop"
}

Write-Host 'Starting the installed DevSpace-Forge Desktop...'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -PlatformRoot "' + $root + '"'
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden

Write-Host ''
Write-Host 'Next: add your allowed project roots, then paste the Cloudflare Remote Tunnel hostname and token in the app.'
Write-Host 'For a new installation, extract the Windows release and run Setup.exe.'
