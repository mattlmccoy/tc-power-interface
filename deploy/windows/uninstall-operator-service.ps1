# Remove the TC-POWER operator's Windows auto-start (the 'TCPowerOperator' Scheduled Task registered by
# install.ps1) and stop the running operator. Leaves the checkout and the log in place.
#
#   & "$HOME\tc-power-interface\deploy\windows\uninstall-operator-service.ps1"
#
# Windows PowerShell 5.1; ASCII only.

$TaskName = 'TCPowerOperator'
$Port = 8010

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the '$TaskName' task."
} else {
    Write-Host "No '$TaskName' task is registered."
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($l in $listeners) {
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped the process listening on port $Port (pid $($l.OwningProcess))."
}
Write-Host 'The operator will no longer start at login. Re-install any time with install.ps1.'
