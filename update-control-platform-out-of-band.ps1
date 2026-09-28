param(
    [Parameter(Mandatory = $true)]
    [string]$SourceExecutable,
    [string]$TargetRoot = $PSScriptRoot,
    [int]$TimeoutSeconds = 45,
    [switch]$Worker
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$PathValue) {
    if ([IO.Path]::IsPathRooted($PathValue)) {
        return [IO.Path]::GetFullPath($PathValue)
    }
    return [IO.Path]::GetFullPath((Join-Path (Get-Location) $PathValue))
}

function Quote-CommandArgument([string]$Value) {
    return '"' + $Value.Replace('"', '""') + '"'
}

function Get-ManagedController([string]$ExecutablePath) {
    return @(
        Get-CimInstance Win32_Process -Filter "Name='DevSpaceControlPlatform.exe'" |
            Where-Object {
                $_.ExecutablePath -and
                [string]::Equals(
                    $_.ExecutablePath,
                    $ExecutablePath,
                    [System.StringComparison]::OrdinalIgnoreCase)
            }
    )
}

function Get-HealthUri([string]$Root) {
    $configPath = Join-Path $Root 'state\devspace-config\config.jsonc'
    if (-not (Test-Path -LiteralPath $configPath)) {
        $configPath = Join-Path $Root 'bin\state\devspace-config\config.jsonc'
    }
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "DevSpace config is missing: $configPath"
    }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $port = [int]$config.server.port
    $healthPath = '/healthz'
    if (-not [string]::IsNullOrWhiteSpace([string]$config.server.publicBaseUrl)) {
        $baseUri = [Uri]([string]$config.server.publicBaseUrl)
        $basePath = $baseUri.AbsolutePath.TrimEnd('/')
        if (-not [string]::IsNullOrWhiteSpace($basePath) -and $basePath -ne '/') {
            $healthPath = $basePath + '/healthz'
        }
    }
    return "http://127.0.0.1:$port$healthPath"
}

function Wait-ForHealthyController(
    [string]$ExecutablePath,
    [string]$HealthUri,
    [int]$Seconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $controller = Get-ManagedController $ExecutablePath | Select-Object -First 1
        if ($controller) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUri -TimeoutSec 2
                if ($response.StatusCode -eq 200) { return $controller }
            }
            catch { }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $null
}

$source = Resolve-FullPath $SourceExecutable
$root = Resolve-FullPath $TargetRoot
$target = Join-Path $root 'DevSpaceControlPlatform.exe'
$logDirectory = Join-Path $root 'logs'
$logPath = Join-Path $logDirectory 'control-platform-update.log'

if (-not (Test-Path -LiteralPath $source)) {
    throw "Source executable does not exist: $source"
}
if (-not (Test-Path -LiteralPath $target)) {
    throw "Production Control Platform executable does not exist: $target"
}
if ([string]::Equals($source, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source executable must be outside the production target path.'
}

New-Item -ItemType Directory -Force $logDirectory | Out-Null

if (-not $Worker) {
    $self = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
    $commandLine = @(
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', (Quote-CommandArgument $self),
        '-SourceExecutable', (Quote-CommandArgument $source),
        '-TargetRoot', (Quote-CommandArgument $root),
        '-TimeoutSeconds', $TimeoutSeconds,
        '-Worker'
    ) -join ' '
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
    }
    if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
        throw "Failed to launch out-of-band updater via WMI. ReturnValue=$($created.ReturnValue)"
    }
    Write-Host "Out-of-band Control Platform updater launched."
    Write-Host "pid=$($created.ProcessId)"
    Write-Host "log=$logPath"
    exit 0
}

function Write-UpdateLog([string]$Message) {
    $line = '{0} {1}' -f ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff')), $Message
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value $line
}

$staged = Join-Path $root ('DevSpaceControlPlatform.next.' + [Guid]::NewGuid().ToString('N') + '.exe')
$backup = Join-Path $root ('DevSpaceControlPlatform.backup.' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.exe')
$healthUri = Get-HealthUri $root

try {
    Write-UpdateLog "worker-start source=$source target=$target"
    Copy-Item -LiteralPath $source -Destination $staged -Force
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
    $stagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $staged).Hash
    if (-not [string]::Equals($sourceHash, $stagedHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Staged executable hash does not match the source.'
    }

    $controllers = Get-ManagedController $target
    foreach ($controller in $controllers) {
        Write-UpdateLog "stop-controller pid=$($controller.ProcessId)"
        Stop-Process -Id $controller.ProcessId -Force -ErrorAction Stop
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Get-ManagedController $target).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if ((Get-ManagedController $target).Count -gt 0) {
        throw 'Existing Control Platform process did not exit.'
    }

    Copy-Item -LiteralPath $target -Destination $backup -Force
    Move-Item -LiteralPath $staged -Destination $target -Force
    Write-UpdateLog "installed sha256=$sourceHash backup=$backup"
    Start-Process -FilePath $target -WorkingDirectory $root

    $healthy = Wait-ForHealthyController $target $healthUri $TimeoutSeconds
    if (-not $healthy) {
        throw "New Control Platform did not restore local DevSpace health within $TimeoutSeconds seconds."
    }
    Write-UpdateLog "update-ok controllerPid=$($healthy.ProcessId) health=$healthUri"
}
catch {
    $failure = $_
    Write-UpdateLog ("update-failed error=" + $failure.Exception.Message)
    Get-ManagedController $target |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $backup) {
        Copy-Item -LiteralPath $backup -Destination $target -Force
        Start-Process -FilePath $target -WorkingDirectory $root
        $restored = Wait-ForHealthyController $target $healthUri $TimeoutSeconds
        if ($restored) {
            Write-UpdateLog "rollback-ok controllerPid=$($restored.ProcessId)"
        }
        else {
            Write-UpdateLog 'rollback-incomplete: previous executable restored but local health did not recover in time'
        }
    }
    throw $failure
}
finally {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
}
