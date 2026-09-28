param(
    [Parameter(Mandatory = $true)]
    [string]$InstanceRoot,
    [int]$SinceHours = 2
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstanceRoot)
$logPath = Join-Path $root 'logs\cloudflared.log'
$cutoff = (Get-Date).AddHours(-[Math]::Max(1, $SinceHours))

$lines = @()
if (Test-Path -LiteralPath $logPath) {
    $lines = Get-Content -LiteralPath $logPath -ErrorAction Stop | Where-Object {
        if ($_ -match '^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})') {
            $parsed = [datetime]::MinValue
            if ([datetime]::TryParseExact($matches.ts, 'yyyy-MM-dd HH:mm:ss.fff', $null, 'None', [ref]$parsed)) {
                return $parsed -ge $cutoff
            }
        }
        return $false
    }
}

$cloudflaredPath = Join-Path $root 'cloudflared.exe'
$process = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -eq $cloudflaredPath) } |
    Select-Object -First 1
$commandLine = if ($process) { [string]$process.CommandLine } else { '' }
$configuredProtocol = 'auto'
if ($commandLine -match '--protocol\s+(auto|quic|http2)') { $configuredProtocol = $matches[1].ToLowerInvariant() }

$actualProtocol = 'unknown'
$registeredLine = $lines | Where-Object { $_ -match 'registered tunnel connection|connection registered' } | Select-Object -Last 1
if ($registeredLine -and $registeredLine -match 'protocol=([^\s]+)') { $actualProtocol = $matches[1] }

[pscustomobject]@{
    active = [bool]$process
    configured_protocol = $configuredProtocol
    actual_protocol = $actualProtocol
    registered = @($lines | Select-String -Pattern 'registered tunnel connection|connection registered').Count
    terminated = @($lines | Select-String -Pattern 'connection terminated').Count
    idle_timeout = @($lines | Select-String -SimpleMatch 'timeout: no recent network activity').Count
    tls_handshake = @($lines | Select-String -SimpleMatch 'TLS handshake with edge error').Count
    quic_dial = @($lines | Select-String -SimpleMatch 'Failed to dial a quic connection').Count
    precheck_fail = @($lines | Select-String -Pattern 'precheck.*status=fail|HTTP/2 connection is blocked or unreachable').Count
}
