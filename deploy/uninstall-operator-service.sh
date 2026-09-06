#!/usr/bin/env bash
# Stop and remove the TC-POWER operator LaunchAgent installed by install-operator-service.sh.
set -euo pipefail

LABEL="com.tcpower.operator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)"

launchctl bootout "$GUI/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL (the operator will no longer auto-start). Log kept at ~/Library/Logs/tcpower-operator.log"
