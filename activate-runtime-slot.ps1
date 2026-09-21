param(
    [string]$SlotName = 'windows-beta4-local12',
    [switch]$Legacy
)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime'
$pointer = Join-Path $runtime 'active-slot.txt'
$previous = Join-Path $runtime 'previous-slot.txt'

$old = if (Test-Path -LiteralPath $pointer) { (Get-Content -Raw -LiteralPath $pointer).Trim() } else { 'legacy' }
Set-Content -LiteralPath $previous -Value $old -Encoding ASCII

if ($Legacy) {
    Remove-Item -LiteralPath $pointer -Force -ErrorAction SilentlyContinue
    Write-Host 'Next DevSpace start will use the legacy runtime.'
    exit 0
}

if ($SlotName -ne [System.IO.Path]::GetFileName($SlotName)) { throw 'Invalid slot name.' }
$slot = Join-Path $runtime (Join-Path 'slots' $SlotName)
if (-not (Test-Path -LiteralPath (Join-Path $slot 'READY'))) { throw "Runtime slot is not ready: $SlotName" }

$temp = $pointer + '.tmp'
Set-Content -LiteralPath $temp -Value $SlotName -Encoding ASCII
Move-Item -LiteralPath $temp -Destination $pointer -Force
Write-Host "Activated runtime slot for the next DevSpace start: $SlotName"
Write-Host "Previous selection: $old"
