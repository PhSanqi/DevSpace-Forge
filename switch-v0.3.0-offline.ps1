param([string]$SlotName = 'windows-local7-win1')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bin = Join-Path $root 'bin'
$runtime = Join-Path $root 'runtime'
$currentExe = Join-Path $bin 'DevSpaceControlPlatform.exe'
$newExe = Join-Path $bin 'DevSpaceControlPlatform.v0.3.0.exe'
$backupExe = Join-Path $bin 'DevSpaceControlPlatform.pre-v0.3.0.exe'
$slot = Join-Path $runtime (Join-Path 'slots' $SlotName)
$serenaExe = Join-Path $runtime 'serena\bin\serena.exe'

function Get-PlatformProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like 'DevSpaceControlPlatform*'
    })
}

function Get-ProjectNodeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
}

function Wait-ForSlotNode([int]$TimeoutSeconds) {
    $expected = (Join-Path $slot 'node\node.exe')
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $match = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $expected, [System.StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1
        if ($match) { return $match }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

Write-Host '=== DevSpaceControlPlatform v0.3.0 offline cutover ==='
if (-not (Test-Path -LiteralPath (Join-Path $slot 'READY'))) {
    throw "Runtime slot is not ready: $SlotName"
}
if (-not (Test-Path -LiteralPath $newExe)) {
    throw "Staged v0.3.0 controller was not found: $newExe"
}
if (-not (Test-Path -LiteralPath $serenaExe)) {
    throw "Serena is not ready: $serenaExe"
}

$serenaVersion = (& $serenaExe --version 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $serenaVersion -notmatch '1\.7\.0') {
    throw "Serena validation failed: $serenaVersion"
}

$platformProcesses = Get-PlatformProcesses
if ($platformProcesses.Count -gt 0) {
    $ids = ($platformProcesses | ForEach-Object { $_.Id }) -join ', '
    throw "Control Platform is still running (PID(s): $ids). Use tray -> 退出并停止服务, then run this script again."
}
$nodeProcesses = Get-ProjectNodeProcesses
if ($nodeProcesses.Count -gt 0) {
    $ids = ($nodeProcesses | ForEach-Object { $_.ProcessId }) -join ', '
    throw "Project DevSpace node.exe is still running (PID(s): $ids). Do not force the switch; stop it cleanly first."
}

Write-Host '1/5 Validate the staged runtime completely offline...'
& (Join-Path $root 'test-runtime-slot.ps1') -SlotName $SlotName
if ($LASTEXITCODE -ne 0) { throw 'Runtime slot validation failed.' }

Write-Host '2/5 Preserve the current controller executable...'
if (-not (Test-Path -LiteralPath $currentExe)) { throw "Current controller missing: $currentExe" }
if (-not (Test-Path -LiteralPath $backupExe)) {
    Copy-Item -LiteralPath $currentExe -Destination $backupExe
}

$pointerChanged = $false
$controllerChanged = $false
try {
    Write-Host '3/5 Replace controller, then activate the validated runtime pointer...'
    Copy-Item -LiteralPath $newExe -Destination $currentExe -Force
    $controllerChanged = $true
    & (Join-Path $root 'activate-runtime-slot.ps1') -SlotName $SlotName
    if ($LASTEXITCODE -ne 0) { throw 'Runtime pointer activation failed.' }
    $pointerChanged = $true

    Write-Host '4/5 Start v0.3.0 and wait for the selected slot...'
    Start-Process -FilePath $currentExe -WorkingDirectory $bin
    $node = Wait-ForSlotNode 25
    if (-not $node) { throw 'v0.3.0 did not start DevSpace from the selected runtime slot within 25 seconds.' }

    Write-Host '5/5 Verify Serena and selected runtime identity...'
    $selected = (Get-Content -Raw -LiteralPath (Join-Path $runtime 'active-slot.txt')).Trim()
    if ($selected -ne $SlotName) { throw "Unexpected active slot after startup: $selected" }
    $slotVersion = (Get-Content -Raw -LiteralPath (Join-Path $slot 'devspace\node_modules\@waishnav\devspace\package.json') | ConvertFrom-Json).version
    if ($slotVersion -ne '1.1.0-beta.3+local.7.win.1') { throw "Unexpected runtime version: $slotVersion" }

    Write-Host ''
    Write-Host 'CUTOVER OK' -ForegroundColor Green
    Write-Host "Controller: v0.3.0"
    Write-Host "Runtime: $slotVersion"
    Write-Host "Slot: $selected"
    Write-Host "Serena: $serenaVersion"
    Write-Host "DevSpace node PID: $($node.ProcessId)"
}
catch {
    Write-Host 'Cutover verification failed; restoring the legacy runtime and controller...' -ForegroundColor Yellow
    Get-PlatformProcesses | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    if ($pointerChanged) {
        & (Join-Path $root 'activate-runtime-slot.ps1') -Legacy
    }
    if ($controllerChanged -and (Test-Path -LiteralPath $backupExe)) {
        Copy-Item -LiteralPath $backupExe -Destination $currentExe -Force
    }
    if ((Get-PlatformProcesses).Count -eq 0 -and (Test-Path -LiteralPath $currentExe)) {
        Start-Process -FilePath $currentExe -WorkingDirectory $bin
    }
    throw
}
