param(
    [string]$NodePath,
    [string]$DevSpacePackageRoot
)

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
    (Join-Path $PSScriptRoot 'src\RuntimeResolver.cs') `
    (Join-Path $PSScriptRoot 'src\SetupInstaller.cs') `
    (Join-Path $PSScriptRoot 'src\DevSpaceReviewRollback.cs') `
    (Join-Path $PSScriptRoot 'src\ManagedAgentInstructions.cs') `
    (Join-Path $PSScriptRoot 'src\ConversationLogStore.cs') `
    (Join-Path $PSScriptRoot 'src\ConfigurationHistory.cs') `
    (Join-Path $PSScriptRoot 'tests\DevSpaceConfigurationTests.cs')

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$node = $null
if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
    $node = if ([IO.Path]::IsPathRooted($NodePath)) {
        [IO.Path]::GetFullPath($NodePath)
    } else {
        [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $NodePath))
    }
}
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    $pointer = Join-Path $PSScriptRoot 'runtime\active-slot.txt'
    if (Test-Path -LiteralPath $pointer) {
        $slotName = (Get-Content -Raw -LiteralPath $pointer).Trim()
        $candidate = Join-Path $PSScriptRoot ('runtime\slots\' + $slotName + '\node\node.exe')
        if (Test-Path -LiteralPath $candidate) { $node = $candidate }
    }
}
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    $candidate = Join-Path $PSScriptRoot 'runtime\node-v22.22.3-win-x64\node.exe'
    if (Test-Path -LiteralPath $candidate) { $node = $candidate }
}
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $node = $command.Source }
}
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    throw 'Node.js runtime was not found for compact runtime smoke testing.'
}
Write-Host "test-node=$node"

$packageRoot = $null
if (-not [string]::IsNullOrWhiteSpace($DevSpacePackageRoot)) {
    $packageRoot = if ([IO.Path]::IsPathRooted($DevSpacePackageRoot)) {
        [IO.Path]::GetFullPath($DevSpacePackageRoot)
    } else {
        [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $DevSpacePackageRoot))
    }
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'dist\process-sessions.js'))) {
        throw "Explicit DevSpace package root is invalid: $packageRoot"
    }
}
if ([string]::IsNullOrWhiteSpace($packageRoot)) {
    $pointer = Join-Path $PSScriptRoot 'runtime\active-slot.txt'
    if (Test-Path -LiteralPath $pointer) {
        $slotName = (Get-Content -Raw -LiteralPath $pointer).Trim()
        $candidate = Join-Path $PSScriptRoot ('runtime\slots\' + $slotName + '\devspace\node_modules\@waishnav\devspace')
        if (Test-Path -LiteralPath (Join-Path $candidate 'dist\process-sessions.js')) { $packageRoot = $candidate }
    }
}
if ([string]::IsNullOrWhiteSpace($packageRoot)) {
    $candidate = Join-Path $PSScriptRoot 'runtime\devspace\node_modules\@waishnav\devspace'
    if (Test-Path -LiteralPath (Join-Path $candidate 'dist\process-sessions.js')) { $packageRoot = $candidate }
}

if ([string]::IsNullOrWhiteSpace($packageRoot)) {
    Write-Host 'compact-runtime-smoke=skipped (no DevSpace runtime in this source-only checkout)'
    exit 0
}

Write-Host "test-devspace-package=$packageRoot"
$previousPackageRoot = $env:DEVSPACE_TEST_PACKAGE_ROOT
try {
    $env:DEVSPACE_TEST_PACKAGE_ROOT = $packageRoot
    & $node (Join-Path $PSScriptRoot 'tests\compact-runtime-smoke.mjs')
    exit $LASTEXITCODE
}
finally {
    $env:DEVSPACE_TEST_PACKAGE_ROOT = $previousPackageRoot
}
