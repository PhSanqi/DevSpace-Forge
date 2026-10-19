param(
    [string]$PlatformRoot = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(1, 65535)][int]$Port = 17678,
    [string]$Instance = 'group',
    [switch]$DisableOwnerCopy
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot)
$config = Join-Path $root 'state\devspace-config\config.jsonc'
$state = Join-Path $root 'state\devspace-state'
if (Test-Path -LiteralPath $config) {
    $raw = Get-Content -Raw -LiteralPath $config
    $stateMatches = [regex]::Matches($raw, '"stateDir"\s*:\s*("(?:\\.|[^"\\])*")')
    if ($stateMatches.Count -gt 1 -or ($stateMatches.Count -eq 0 -and $raw.Contains('"stateDir"'))) { throw 'Ambiguous Runtime state directory.' }
    if ($stateMatches.Count -eq 1) { $state = $stateMatches[0].Groups[1].Value | ConvertFrom-Json }
    if (-not [IO.Path]::IsPathRooted($state)) { throw 'Runtime state directory must be absolute.' }
}
$selectionFile = Join-Path $state 'runtime-selection.json'
$selection = $null
if (Test-Path -LiteralPath $selectionFile) {
    $selection = Get-Content -Raw -LiteralPath $selectionFile | ConvertFrom-Json
    if ($null -eq $selection -or $selection.schema_version -is [string] -or $selection.schema_version -ne 1 -or $selection.PSObject.Properties.Name -notcontains 'previous' -or $selection.slot -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $selection.server_sha256 -notmatch '^[a-f0-9]{64}$' -or
        ($null -ne $selection.previous -and ($selection.previous.slot -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $selection.previous.server_sha256 -notmatch '^[a-f0-9]{64}$'))) {
        throw 'Invalid Runtime JSON selection; legacy mirror was not used.'
    }
    $slot = [string]$selection.slot
} else {
    $pointer = Join-Path $root 'runtime\active-slot.txt'
    $slot = if (Test-Path -LiteralPath $pointer) { (Get-Content -Raw -LiteralPath $pointer).Trim() } else { '' }
    if ($slot -and $slot -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid legacy Runtime slot.' }
}
$runtime = if ($slot) { Join-Path $root ('runtime\slots\' + $slot) } else { Join-Path $root 'runtime' }
$nodeCandidates = @((Join-Path $runtime 'node\node.exe'))
if ($null -eq $selection) { $nodeCandidates += (Join-Path $runtime 'node\bin\node.exe') }
$node = $nodeCandidates |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $node -and $null -eq $selection) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
}
if (-not $node) { throw 'Node.js could not be found for the Control Console.' }

$package = Join-Path $runtime 'devspace\node_modules\@waishnav\devspace'
if ($null -eq $selection -and -not (Test-Path -LiteralPath (Join-Path $package 'package.json'))) {
    $package = Join-Path $runtime 'node_modules\@waishnav\devspace'
}
if (-not (Test-Path -LiteralPath (Join-Path $package 'package.json'))) {
    throw 'The configured DevSpace runtime package could not be found.'
}

if ($null -ne $selection) {
    $server = Join-Path $package 'dist\server.js'
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'READY')) -or -not (Test-Path -LiteralPath (Join-Path $package 'dist\cli.js')) -or
        (Get-FileHash -LiteralPath $server -Algorithm SHA256).Hash.ToLowerInvariant() -ne $selection.server_sha256) {
        throw 'Selected Runtime readiness/hash mismatch; legacy mirror was not used.'
    }
}

$console = Join-Path $root 'ops\runtime-console.mjs'
if (-not (Test-Path -LiteralPath $console)) { throw 'Runtime Console assets are missing from the Control package.' }
$tokenFile = Join-Path $root 'state\secrets\cloudflare-tunnel-token.txt'
$arguments = @(
    $console, '--instance', $Instance, '--platform-root', $root,
    '--config', $config, '--runtime-package', $package,
    '--tunnel-token-file', $tokenFile, '--serve', "$Port"
)
if (-not $DisableOwnerCopy) {
    $credentials = Join-Path $root 'state\devspace-config\auth.json'
    if (Test-Path -LiteralPath $credentials) {
        $arguments += @('--credential-file', $credentials, '--allow-owner-copy', 'true')
    }
}
Write-Host "DevSpace Runtime Console: http://127.0.0.1:$Port/"
& $node @arguments
exit $LASTEXITCODE
