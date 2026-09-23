# Supervisor for the TC-POWER operator on Windows.
#
# Launched hidden at logon by the 'TCPowerOperator' Scheduled Task that install.ps1 registers. It keeps
# the operator alive: if tcp-serve exits for any reason it is restarted after a short pause -- the
# Windows equivalent of launchd KeepAlive on macOS (deploy/install-operator-service.sh).
#
# Output goes to %LOCALAPPDATA%\tcpower\operator.log (rotated to operator.log.1 past 10 MB).
# Written for Windows PowerShell 5.1 (the version that ships with Windows); ASCII only.

param(
    [string]$Uv = 'uv',
    [int]$Port = 8010,
    [string]$FlirUrl = 'http://127.0.0.1:8000'
)

$backend = (Resolve-Path (Join-Path $PSScriptRoot '..\..\backend')).Path
$logDir = Join-Path $env:LOCALAPPDATA 'tcpower'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'operator.log'

$env:PYTHONUNBUFFERED = '1'  # stream log lines as they happen instead of in blocks
Set-Location $backend

function Write-Log([string]$line) {
    Add-Content -Path $log -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format s), $line)
}

while ($true) {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 10MB)) {
        Move-Item -Force $log "$log.1"
    }
    Write-Log "starting tcp-serve on 127.0.0.1:$Port (flir-url $FlirUrl)"
    & $Uv run tcp-serve --host 127.0.0.1 --port $Port --flir-url $FlirUrl 2>&1 |
        ForEach-Object { "$_" } |
        Add-Content -Path $log -Encoding UTF8
    Write-Log "tcp-serve exited (code $LASTEXITCODE); restarting in 5 s"
    Start-Sleep -Seconds 5
}
