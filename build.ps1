param([string]$OutputPath)

$ErrorActionPreference = 'Stop'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    throw '.NET Framework 4.x C# compiler was not found.'
}

$outputDir = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force $outputDir | Out-Null
$output = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Join-Path $outputDir 'DevSpaceControlPlatform.exe'
} else {
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $OutputPath))
}
New-Item -ItemType Directory -Force (Split-Path $output) | Out-Null

& (Join-Path $PSScriptRoot 'make-icon.ps1')

& $csc /nologo /target:winexe /optimize+ `
    /win32icon:DevSpaceControlPlatform.ico `
    /resource:DevSpaceControlPlatform.ico,DevSpaceControlPlatform.Icon `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.Security.dll `
    /out:$output `
    (Join-Path $PSScriptRoot 'src\Program.cs') `
    (Join-Path $PSScriptRoot 'src\AppVisuals.cs') `
    (Join-Path $PSScriptRoot 'src\ControlApplicationContext.cs') `
    (Join-Path $PSScriptRoot 'src\MainForm.cs') `
    (Join-Path $PSScriptRoot 'src\ServiceSupervisor.cs') `
    (Join-Path $PSScriptRoot 'src\RuntimeConsole.cs') `
    (Join-Path $PSScriptRoot 'src\ConversationLogStore.cs') `
    (Join-Path $PSScriptRoot 'src\RuntimeResolver.cs') `
    (Join-Path $PSScriptRoot 'src\SetupInstaller.cs') `
    (Join-Path $PSScriptRoot 'src\PlatformSettings.cs') `
    (Join-Path $PSScriptRoot 'src\CloudflareTunnelSecretStore.cs') `
    (Join-Path $PSScriptRoot 'src\LegacyQuickConfigImporter.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceConfiguration.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceEffectiveStateVerifier.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceCliRunner.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceReviewRollback.cs') `
    (Join-Path $PSScriptRoot 'src\ManagedAgentInstructions.cs') `
    (Join-Path $PSScriptRoot 'src\ConfigurationHistory.cs')

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built $output"
