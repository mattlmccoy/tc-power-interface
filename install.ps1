# One-command installer for the TC-POWER operator on Windows (the local generator server the web UI
# talks to). Run it in PowerShell:
#
#   irm https://raw.githubusercontent.com/mattlmccoy/tc-power-interface/main/install.ps1 | iex
#
# It clones (or updates) this repo and registers the operator as a per-user Scheduled Task named
# 'TCPowerOperator' that starts when you log in and is kept alive by a small supervisor loop
# (deploy\windows\run-operator.ps1) -- so it survives reboots and restarts itself if it dies. This is
# the Windows twin of the macOS launchd service installed by install.sh. Re-running it updates the
# checkout and restarts the operator.
#
# Requires git and uv on PATH. Clones to $HOME\tc-power-interface; to use an existing checkout
# elsewhere, run   $env:TCP_DIR = 'C:\path\to\tc-power-interface'   first.
# Remove it with deploy\windows\uninstall-operator-service.ps1 in the checkout.
#
# Written for Windows PowerShell 5.1 (ships with Windows); ASCII only. Because it runs via
# 'irm | iex' in YOUR session, it never calls 'exit' (that would close the window) and never changes
# session-wide settings -- everything runs inside one function that returns on failure.

function Install-TcpOperator {
    $RepoUrl = 'https://github.com/mattlmccoy/tc-power-interface.git'
    $Dest = if ($env:TCP_DIR) { $env:TCP_DIR } else { Join-Path $HOME 'tc-power-interface' }
    $TaskName = 'TCPowerOperator'
    $Port = 8010
    $FlirUrl = 'http://127.0.0.1:8000'

    function Say([string]$msg) { Write-Host $msg }
    function Fail([string]$msg) { Write-Host "error: $msg" -ForegroundColor Red }

    if ($env:OS -ne 'Windows_NT') { Fail 'this installer is for Windows. On macOS use install.sh.'; return }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { Fail "'git' not found on PATH. Install Git for Windows (winget install --id Git.Git -e), then re-run."; return }
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
        Fail "'uv' not found on PATH. Install it with:"
        Say '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        Say 'then open a NEW PowerShell window and re-run this installer.'
        return
    }
    $uvPath = $uv.Source

    # 1. Stop any running operator first, so the update can replace files and the new code loads:
    #    the scheduled task (its supervisor loop) and anything already listening on the port (e.g. an
    #    operator you started by hand in another window).
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Say "Stopping the existing '$TaskName' task ..."
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($l in $listeners) {
        $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
        if ($p) {
            Say "Stopping $($p.ProcessName) (pid $($p.Id)) listening on port $Port ..."
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1

    # 2. Clone or fast-forward the checkout.
    if (Test-Path (Join-Path $Dest '.git')) {
        Say "Updating existing checkout at $Dest ..."
        & git -C $Dest pull --ff-only
        if ($LASTEXITCODE -ne 0) { Fail "git pull failed in $Dest (local changes?). Resolve it, then re-run."; return }
    } elseif (Test-Path $Dest) {
        Fail "$Dest exists but is not a git checkout. Move it aside or set `$env:TCP_DIR, then re-run."
        return
    } else {
        Say "Cloning $RepoUrl -> $Dest ..."
        & git clone --depth 1 $RepoUrl $Dest
        if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.'; return }
    }

    $backend = Join-Path $Dest 'backend'
    $runner = Join-Path $Dest 'deploy\windows\run-operator.ps1'
    if (-not (Test-Path $runner)) { Fail "supervisor not found at $runner (unexpected repo layout)."; return }

    # 3. Resolve Python + dependencies now, in the foreground, so any problem shows up here rather than
    #    silently inside the hidden task.
    Say 'Installing Python dependencies (uv sync) ...'
    Push-Location $backend
    & $uvPath sync
    $syncCode = $LASTEXITCODE
    Pop-Location
    if ($syncCode -ne 0) { Fail "uv sync failed (exit $syncCode). Fix the error above, then re-run."; return }

    # 4. Register the per-user logon task. Interactive + Limited = runs as you, no admin needed, no
    #    stored password. No time limit; Task Scheduler also retries if the supervisor itself fails.
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Uv "{1}" -Port {2} -FlirUrl "{3}"' -f $runner, $uvPath, $Port, $FlirUrl
    try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $backend
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
            -Settings $settings -Force -ErrorAction Stop `
            -Description 'TC-POWER operator (http://127.0.0.1:8010). Installed by install.ps1.' | Out-Null
    } catch {
        Fail "could not register the '$TaskName' task: $($_.Exception.Message)"
        Say 'If this says access is denied, re-run from PowerShell opened with "Run as administrator".'
        return
    }

    # 5. Start it now and wait for the operator to answer.
    Say "Starting the '$TaskName' task ..."
    Start-ScheduledTask -TaskName $TaskName
    $health = $null
    for ($i = 0; $i -lt 45; $i++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing
            break
        } catch {
            Start-Sleep -Seconds 2
        }
    }

    $log = Join-Path $env:LOCALAPPDATA 'tcpower\operator.log'
    Say ''
    if ($health) {
        Write-Host "Done. The operator is running at http://127.0.0.1:$Port (v$($health.app_version))." -ForegroundColor Green
        Say 'It starts automatically when you log in and restarts itself if it stops.'
        Say 'Reload the web page -- it reconnects on its own.'
    } else {
        Fail "the task is registered but the operator did not answer on port $Port within 90 s."
        Say "Check the log: $log"
    }
    Say ''
    Say "  log:        $log"
    Say "  start now:  Start-ScheduledTask -TaskName $TaskName"
    Say "  stop:       Stop-ScheduledTask -TaskName $TaskName"
    Say "  debug run:  cd `"$backend`"; uv run tcp-serve --host 127.0.0.1 --port $Port --flir-url $FlirUrl"
    Say "  uninstall:  & `"$(Join-Path $Dest 'deploy\windows\uninstall-operator-service.ps1')`""
}

Install-TcpOperator
