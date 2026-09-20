param(
    [Parameter(Mandatory = $true)]
    [string]$SlotName,
    [int]$TimeoutSeconds = 40
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$pointer = Join-Path $runtime 'active-slot.txt'
$slot = Join-Path $runtime (Join-Path 'slots' $SlotName)

function Get-ManagedDevSpaceNodes {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf('dist\cli.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine.IndexOf(' serve', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Get-ActiveSlotName {
    if (-not (Test-Path -LiteralPath $pointer)) { return 'legacy' }
    $value = (Get-Content -Raw -LiteralPath $pointer).Trim()
    return $(if ([string]::IsNullOrWhiteSpace($value)) { 'legacy' } else { $value })
}

function Set-ActiveSlotName([string]$Name) {
    if ($Name -eq 'legacy') {
        & (Join-Path $root 'activate-runtime-slot.ps1') -Legacy
    } else {
        & (Join-Path $root 'activate-runtime-slot.ps1') -SlotName $Name
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed to select runtime slot: $Name" }
}

function Test-LocalHealth {
    try {
        $configPath = Join-Path $root 'bin\state\devspace-config\config.jsonc'
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        $port = [int]$config.server.port
        $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/healthz" -f $port) -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Wait-ForTarget([string]$ExpectedSlot, [int]$Seconds) {
    $expectedNode = if ($ExpectedSlot -eq 'legacy') {
        Join-Path $runtime 'node-v22.22.3-win-x64\node.exe'
    } else {
        Join-Path $runtime (Join-Path ('slots\' + $ExpectedSlot) 'node\node.exe')
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $match = Get-ManagedDevSpaceNodes | Where-Object {
            [string]::Equals($_.ExecutablePath, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1
        if ($match -and (Test-LocalHealth)) { return $match }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

if (-not (Test-Path -LiteralPath (Join-Path $slot 'READY'))) {
    throw "Runtime slot is not ready: $SlotName"
}

$controllers = @(Get-Process -Name 'DevSpaceControlPlatform' -ErrorAction SilentlyContinue)
if ($controllers.Count -eq 0) {
    throw 'DevSpace Control Platform is not running; use activate-runtime-slot.ps1 for an offline selection instead.'
}

Write-Host "Validating target slot: $SlotName"
& (Join-Path $root 'test-runtime-slot.ps1') -SlotName $SlotName
if ($LASTEXITCODE -ne 0) { throw 'Target runtime slot validation failed.' }

$previous = Get-ActiveSlotName
$before = Get-ManagedDevSpaceNodes
if ($before.Count -eq 0) { throw 'No managed DevSpace serve process is currently running.' }

try {
    Write-Host "Switching runtime selection: $previous -> $SlotName"
    Set-ActiveSlotName $SlotName
    $before | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }

    $targetProcess = Wait-ForTarget $SlotName $TimeoutSeconds
    if (-not $targetProcess) {
        throw "DevSpace did not recover on runtime slot $SlotName within $TimeoutSeconds seconds."
    }

    Write-Host 'LIVE SLOT SWITCH OK' -ForegroundColor Green
    Write-Host "slot=$SlotName"
    Write-Host "nodePid=$($targetProcess.ProcessId)"
    Write-Host "nodePath=$($targetProcess.ExecutablePath)"
}
catch {
    $failure = $_
    Write-Host "Live slot switch failed; restoring $previous ..." -ForegroundColor Yellow
    Set-ActiveSlotName $previous
    Get-ManagedDevSpaceNodes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $restored = Wait-ForTarget $previous $TimeoutSeconds
    if ($restored) {
        Write-Host "Rollback recovered DevSpace on $previous." -ForegroundColor Yellow
    } else {
        Write-Host "Rollback pointer was restored to $previous, but automatic service recovery did not become healthy in time." -ForegroundColor Red
    }
    throw $failure
}
