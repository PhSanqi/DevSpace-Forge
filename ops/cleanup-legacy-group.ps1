param(
    [switch]$Execute,
    [switch]$IncludeLegacyWorktrees
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$controlRoot = Split-Path -Parent $projectRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $controlRoot)
$legacyRuntime = Join-Path $workspaceRoot '.devspace-runtime'
$legacyWorktrees = Join-Path $env:USERPROFILE '.devspace\worktrees'
$publishWorktree = Join-Path $controlRoot 'DevSpaceControlPlatform-publish'
$testOutput = Join-Path $projectRoot '.test-output'
$binOutput = Join-Path $projectRoot 'bin'
$distOutput = Join-Path $projectRoot 'dist'
$beta3Inspect = Join-Path $projectRoot '.devspace-beta3-inspect'
$legacyCloudflaredData = 'C:\ProgramData\cloudflared'

function Test-ListeningPort([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Assert-SafeMigrationState {
    if (-not (Test-ListeningPort 17677)) {
        throw 'Refusing cleanup: new group DevSpace is not listening on 17677.'
    }
    if (Test-ListeningPort 7677) {
        throw 'Refusing cleanup: legacy 7677 is still listening.'
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:17677/group/mcp' -Method Get -TimeoutSec 3 -MaximumRedirection 0
        $status = [int]$response.StatusCode
    }
    catch {
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode.value__ }
        else { throw 'Refusing cleanup: new group MCP probe failed.' }
    }
    if ($status -ne 401) {
        throw "Refusing cleanup: expected unauthenticated group MCP status 401, got $status."
    }
}

function Add-Candidate([string]$Kind, [string]$Path, [string]$Reason) {
    [pscustomobject]@{ Kind = $Kind; Path = $Path; Exists = Test-Path -LiteralPath $Path; Reason = $Reason }
}

function Remove-RegisteredWorktree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $common = (& git -C $Path rev-parse --path-format=absolute --git-common-dir 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $common) {
        $repo = Split-Path -Parent $common.Trim()
        & git -C $repo worktree remove --force $Path 2>$null
        if ($LASTEXITCODE -eq 0) { return }
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

Assert-SafeMigrationState

$candidates = @(
    (Add-Candidate 'directory' $legacyRuntime 'legacy 4060/cloudflared runtime logs'),
    (Add-Candidate 'worktree' $publishWorktree 'obsolete publish-v0.2 worktree'),
    (Add-Candidate 'directory' $testOutput 'generated test output and temporary worktrees'),
    (Add-Candidate 'generated' $binOutput 'remove legacy bin state/logs/old executables; keep latest DevSpaceControlPlatform.exe and Setup.exe'),
    (Add-Candidate 'directory' $distOutput 'stale generated release artifacts; reproducible'),
    (Add-Candidate 'directory' $beta3Inspect 'obsolete beta3 inspection directory'),
    (Add-Candidate 'directory' $legacyCloudflaredData 'legacy Windows service token/config data')
)

if ($IncludeLegacyWorktrees) {
    $candidates += Add-Candidate 'worktrees' $legacyWorktrees 'legacy pre-migration DevSpace/CFR worktrees; verified clean before migration'
}

$service = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
$runKey = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
$fixedRunValue = $null
if ($runKey) { $fixedRunValue = $runKey.DevSpaceControlPlatform }

Write-Host 'Legacy cleanup plan:'
$candidates | Format-Table -AutoSize
Write-Host ("Cloudflared service: " + $(if ($service) { $service.Status.ToString() + ' / ' + $service.StartType } else { 'absent' }))
Write-Host ("Fixed Run value: " + $(if ($fixedRunValue) { 'present' } else { 'absent' }))

if (-not $Execute) {
    Write-Host 'DRY RUN ONLY. Re-run with -Execute after explicit authorization.'
    exit 0
}

if ($service) {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name 'Cloudflared' -Force }
    & sc.exe delete Cloudflared | Out-Null
}

if ($runKey -and $fixedRunValue) {
    Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'DevSpaceControlPlatform' -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $publishWorktree) {
    & git -C $projectRoot worktree remove --force $publishWorktree
    if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $publishWorktree)) {
        throw 'Failed to remove obsolete publish worktree cleanly.'
    }
}

foreach ($path in @($legacyRuntime, $testOutput, $distOutput, $beta3Inspect, $legacyCloudflaredData)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}

if (Test-Path -LiteralPath $binOutput) {
    foreach ($item in Get-ChildItem -LiteralPath $binOutput -Force) {
        if ($item.Name -in @('DevSpaceControlPlatform.exe', 'Setup.exe')) { continue }
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
}

if ($IncludeLegacyWorktrees -and (Test-Path -LiteralPath $legacyWorktrees)) {
    foreach ($worktree in Get-ChildItem -LiteralPath $legacyWorktrees -Directory -Force) {
        $dirty = & git -C $worktree.FullName status --porcelain 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Cannot verify legacy worktree: $($worktree.FullName)" }
        if ($dirty) { throw "Refusing to delete dirty legacy worktree: $($worktree.FullName)" }
        Remove-RegisteredWorktree $worktree.FullName
    }
    if ((Get-ChildItem -LiteralPath $legacyWorktrees -Force -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
        Remove-Item -LiteralPath $legacyWorktrees -Force
    }
}

& git -C $projectRoot worktree prune
Write-Host 'Legacy cleanup completed.'
