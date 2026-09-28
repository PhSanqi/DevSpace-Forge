$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime'
$pointer = Join-Path $runtime 'active-slot.txt'
$previous = Join-Path $runtime 'previous-slot.txt'
if (-not (Test-Path -LiteralPath $previous)) { throw 'No previous runtime selection was recorded.' }
$target = (Get-Content -Raw -LiteralPath $previous).Trim()
if ($target -eq 'legacy' -or [string]::IsNullOrWhiteSpace($target)) {
    Remove-Item -LiteralPath $pointer -Force -ErrorAction SilentlyContinue
    Write-Host 'Rolled runtime selection back to legacy.'
    exit 0
}
$slot = Join-Path $runtime (Join-Path 'slots' $target)
if (-not (Test-Path -LiteralPath (Join-Path $slot 'READY'))) { throw "Previous runtime slot is not ready: $target" }
Set-Content -LiteralPath $pointer -Value $target -Encoding ASCII
Write-Host "Rolled runtime selection back to: $target"
