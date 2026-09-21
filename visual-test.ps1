$ErrorActionPreference = 'Stop'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$outputDir = Join-Path $PSScriptRoot '.test-output\ui-snapshots'
$executable = Join-Path $PSScriptRoot '.test-output\VisualLayoutSnapshot.exe'
New-Item -ItemType Directory -Force $outputDir | Out-Null

& $csc /nologo /target:exe /optimize+ /main:VisualLayoutSnapshot `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.Security.dll `
    /out:$executable `
    (Join-Path $PSScriptRoot 'src\AppVisuals.cs') `
    (Join-Path $PSScriptRoot 'src\MainForm.cs') `
    (Join-Path $PSScriptRoot 'src\ServiceSupervisor.cs') `
    (Join-Path $PSScriptRoot 'src\RuntimeConsole.cs') `
    (Join-Path $PSScriptRoot 'src\ConversationLogStore.cs') `
    (Join-Path $PSScriptRoot 'src\RuntimeResolver.cs') `
    (Join-Path $PSScriptRoot 'src\PlatformSettings.cs') `
    (Join-Path $PSScriptRoot 'src\CloudflareTunnelSecretStore.cs') `
    (Join-Path $PSScriptRoot 'src\LegacyQuickConfigImporter.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceConfiguration.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceEffectiveStateVerifier.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceCliRunner.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceReviewRollback.cs') `
    (Join-Path $PSScriptRoot 'src\ManagedAgentInstructions.cs') `
    (Join-Path $PSScriptRoot 'src\ConfigurationHistory.cs') `
    (Join-Path $PSScriptRoot 'tests\VisualLayoutSnapshot.cs')

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $executable $outputDir
exit $LASTEXITCODE
