$ErrorActionPreference = 'Stop'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    throw '.NET Framework 4.x C# compiler was not found.'
}

$output = Join-Path $PSScriptRoot '.test-output\DevSpaceConfigurationTests.exe'
New-Item -ItemType Directory -Force (Split-Path $output) | Out-Null

& $csc /nologo /target:exe /optimize+ `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Web.Extensions.dll `
    /reference:System.Security.dll `
    /out:$output `
    (Join-Path $PSScriptRoot 'src\PlatformSettings.cs') `
    (Join-Path $PSScriptRoot 'src\CloudflareTunnelSecretStore.cs') `
    (Join-Path $PSScriptRoot 'src\LegacyQuickConfigImporter.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceConfiguration.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceEffectiveStateVerifier.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceCliRunner.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceReviewRollback.cs') `
    (Join-Path $PSScriptRoot 'src\ManagedAgentInstructions.cs') `
    (Join-Path $PSScriptRoot 'src\ConversationLogStore.cs') `
    (Join-Path $PSScriptRoot 'src\ConfigurationHistory.cs') `
    (Join-Path $PSScriptRoot 'tests\DevSpaceConfigurationTests.cs')

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $output
exit $LASTEXITCODE
