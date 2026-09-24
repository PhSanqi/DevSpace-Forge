param(
    [string]$PlatformRoot = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(1, 65535)][int]$Port = 17678,
    [string]$Instance = 'group'
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot)
$pointer = Join-Path $root 'runtime\active-slot.txt'
$slot = if (Test-Path -LiteralPath $pointer) { (Get-Content -Raw -LiteralPath $pointer).Trim() } else { '' }
$runtime = if ($slot -match '^[A-Za-z0-9._-]+$') { Join-Path $root ('runtime\slots\' + $slot) } else { Join-Path $root 'runtime' }
$node = @((Join-Path $runtime 'node\node.exe'), (Join-Path $runtime 'node\bin\node.exe')) |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $node) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
}
if (-not $node) { throw 'Node.js could not be found for the Control Console.' }

$package = Join-Path $runtime 'devspace\node_modules\@waishnav\devspace'
if (-not (Test-Path -LiteralPath (Join-Path $package 'package.json'))) {
    $package = Join-Path $runtime 'node_modules\@waishnav\devspace'
}
if (-not (Test-Path -LiteralPath (Join-Path $package 'package.json'))) {
    throw 'The configured DevSpace runtime package could not be found.'
}

$console = Join-Path $root 'ops\runtime-console.mjs'
if (-not (Test-Path -LiteralPath $console)) { throw 'Runtime Console assets are missing from the Control package.' }
$config = Join-Path $root 'state\devspace-config\config.jsonc'
$targetCli = Join-Path $package 'dist\cli.js'
$processInfo = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($targetCli) } |
    Select-Object -First 1
$arguments = @(
    $console, '--instance', $Instance, '--platform-root', $root,
    '--config', $config, '--runtime-package', $package, '--serve', "$Port"
)
if ($processInfo) { $arguments += @('--pid', "$($processInfo.ProcessId)") }
Write-Host "DevSpace Runtime Console: http://127.0.0.1:$Port/"
& $node @arguments
exit $LASTEXITCODE
