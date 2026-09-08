$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$size = 64
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(32, 38, 48))
$accent = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 200, 250)), 5
$accent.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$accent.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$node = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 200, 250))

$graphics.FillEllipse($background, 3, 3, 58, 58)
$graphics.DrawLine($accent, 20, 32, 32, 20)
$graphics.DrawLine($accent, 32, 20, 44, 32)
$graphics.DrawLine($accent, 32, 20, 32, 45)
$graphics.FillEllipse($node, 15, 27, 10, 10)
$graphics.FillEllipse($white, 27, 15, 10, 10)
$graphics.FillEllipse($node, 39, 27, 10, 10)
$graphics.FillEllipse($white, 27, 40, 10, 10)

$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$path = Join-Path $PSScriptRoot 'DevSpaceControlPlatform.ico'
$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
try {
    $icon.Save($stream)
}
finally {
    $stream.Dispose()
    $icon.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    $background.Dispose()
    $accent.Dispose()
    $white.Dispose()
    $node.Dispose()
}

Write-Host "Generated $path"
