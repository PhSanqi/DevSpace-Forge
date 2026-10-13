param(
    [string]$PlatformRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$consoleScript = Join-Path $root 'ops\runtime-console.mjs'
$startConsole = Join-Path $root 'ops\start-runtime-console.ps1'
$desktop = Join-Path $root 'desktop\DevSpaceForgeDesktop.exe'
$pointer = Join-Path $root 'runtime\active-slot.txt'
$slot = if (Test-Path -LiteralPath $pointer) { (Get-Content -Raw -LiteralPath $pointer).Trim() } else { '' }
if ($slot -notmatch '^[A-Za-z0-9._-]+$' -or $slot -in @('.', '..')) {
    throw 'Active Runtime slot is missing or invalid.'
}
$node = Join-Path $root ("runtime\slots\$slot\node\node.exe")
foreach ($file in @($node, $consoleScript, $startConsole, $desktop)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Modern Control asset is missing: $file" }
}

function Resolve-ControlInstance {
    $settingsPath = Join-Path $root 'settings.json'
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { return 'group' }
    try {
        $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
        $fixedHostname = [string]$settings.FixedHostname
        if ([string]::IsNullOrWhiteSpace($fixedHostname)) { return 'group' }
        $candidate = $fixedHostname.Trim()
        if ($candidate -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') { $candidate = 'https://' + $candidate }
        $uri = [Uri]$candidate
        $path = $uri.AbsolutePath.Trim('/')
        if ([string]::IsNullOrWhiteSpace($path)) { return 'group' }
        $instance = (($path -split '/')[-1]).ToLowerInvariant()
        if ($instance -notmatch '^[a-z0-9][a-z0-9._-]*$') {
            throw 'FixedHostname path does not contain a valid Control instance.'
        }
        return $instance
    } catch {
        throw 'Cannot resolve modern Control instance from settings.json.'
    }
}
$instance = Resolve-ControlInstance

$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$bytes = [Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant() + '|' + $user)
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
finally { $sha.Dispose() }
$mutex = [Threading.Mutex]::new($false, "Local\DevSpaceForgeDesktop-$hash")
$locked = $false
try {
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(15)) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Timed out waiting for the modern Control launcher lock.' }

    $legacy = Join-Path $root 'DevSpaceControlPlatform.exe'
    $conflict = Get-CimInstance Win32_Process -Filter "Name='DevSpaceControlPlatform.exe'" -ErrorAction Stop |
        Where-Object {
            if (-not $_.ExecutablePath) { throw 'Cannot verify legacy Control process path.' }
            [string]::Equals(
            [IO.Path]::GetFullPath($_.ExecutablePath), $legacy,
            [StringComparison]::OrdinalIgnoreCase)
        } |
        Select-Object -First 1
    if ($conflict) { throw 'Migration conflict: legacy DevSpaceControlPlatform.exe is running from this platform root.' }

    $url = 'http://127.0.0.1:17678/next/'
    $script:controlConflict = $false
    function Test-ControlReady {
        $script:controlConflict = $false
        try {
            $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
            $status = Invoke-WebRequest -Uri 'http://127.0.0.1:17678/api/status' -UseBasicParsing -TimeoutSec 2
            $body = $status.Content | ConvertFrom-Json
            if ($page.StatusCode -ne 200 -or $status.StatusCode -ne 200 -or
                $page.Content -notmatch '<html' -or $body.schema_version -ne 2 -or
                $body.instance -ne $instance -or $body.security.loopback_console_only -ne $true) {
                return $false
            }
            $configuredPackage = [IO.Path]::GetFullPath([string]$body.runtime.configured.package_root)
            $runtimeRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime'))).TrimEnd('\') + '\'
            if (-not $configuredPackage.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
                $script:controlConflict = $true
                return $false
            }
            return $true
        } catch { return $false }
    }
    $ready = Test-ControlReady
    if (-not $ready) {
        if ($script:controlConflict) { throw 'Control conflict: port 17678 belongs to another platform root.' }
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-File', ('"' + $startConsole + '"'),
            '-PlatformRoot', ('"' + $root + '"'), '-Port', '17678', '-Instance', $instance
        ) | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not $ready -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 500
            $ready = Test-ControlReady
            if ($script:controlConflict) { throw 'Control conflict: port 17678 belongs to another platform root.' }
        }
        if (-not $ready) { throw 'Modern Control console did not become ready on 127.0.0.1:17678.' }
    }

    $env:DEVSPACE_CONTROL_URL = $url
    $env:DEVSPACE_PLATFORM_ROOT = $root
    $desktopProcess = Start-Process -FilePath $desktop -PassThru -Wait
    $shellExitCode = $desktopProcess.ExitCode
}
finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $shellExitCode
