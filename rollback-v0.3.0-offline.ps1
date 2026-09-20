$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bin = Join-Path $root 'bin'
$currentExe = Join-Path $bin 'DevSpaceControlPlatform.exe'
$backupExe = Join-Path $bin 'DevSpaceControlPlatform.pre-v0.3.0.exe'

$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like 'DevSpaceControlPlatform*'
})
if ($running.Count -gt 0) {
    $ids = ($running | ForEach-Object { $_.Id }) -join ', '
    throw "Control Platform is still running (PID(s): $ids). Use tray -> 退出并停止服务 before rollback."
}
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
})
if ($nodes.Count -gt 0) {
    $ids = ($nodes | ForEach-Object { $_.ProcessId }) -join ', '
    throw "Project DevSpace node.exe is still running (PID(s): $ids). Stop it cleanly before rollback."
}
if (-not (Test-Path -LiteralPath $backupExe)) {
    throw "Pre-v0.3.0 controller backup not found: $backupExe"
}

& (Join-Path $root 'activate-runtime-slot.ps1') -Legacy
Copy-Item -LiteralPath $backupExe -Destination $currentExe -Force
Start-Process -FilePath $currentExe -WorkingDirectory $bin
Write-Host 'Rollback complete: legacy runtime + pre-v0.3.0 controller restored.' -ForegroundColor Green
