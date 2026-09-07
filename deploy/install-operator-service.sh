#!/usr/bin/env bash
# Install the TC-POWER operator as an always-on macOS background service (LaunchAgent).
#
# After this, `tcp-serve` starts automatically at login, restarts if it dies, and is always
# reachable at http://127.0.0.1:8010 — so the web UI (local or GitHub Pages) always finds it and
# settings always save. Reversible with ./uninstall-operator-service.sh.
#
# Boots IDLE by default (no device): open the UI and use the connect popover to discover the serial
# port and attach the real generator at runtime. (You can still pin a device at startup by editing
# the plist's ProgramArguments to add:  --serial /dev/tty.usbserial-XXXX)
set -euo pipefail

LABEL="com.tcpower.operator"
PORT="${TCP_PORT:-8010}"

# Resolve paths from this script's location (portable — no hardcoded home path).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"
UV_BIN="$(command -v uv || true)"
if [[ -z "$UV_BIN" ]]; then
  echo "error: 'uv' not found on PATH. Install uv first (https://docs.astral.sh/uv/)." >&2
  exit 1
fi
UV_DIR="$(dirname "$UV_BIN")"

AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
LOG="$HOME/Library/Logs/tcpower-operator.log"
mkdir -p "$AGENTS_DIR" "$(dirname "$LOG")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>            <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$UV_BIN</string>
        <string>run</string>
        <string>tcp-serve</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>$PORT</string>
    </array>
    <key>WorkingDirectory</key> <string>$BACKEND_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key> <string>$UV_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>        <true/>
    <key>KeepAlive</key>        <true/>
    <key>StandardOutPath</key>  <string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

# (Re)load it. bootstrap/bootout are the modern launchctl verbs; fall back to load/unload.
GUI="gui/$(id -u)"
launchctl bootout "$GUI/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "$GUI" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "Installed + started $LABEL"
echo "  plist:  $PLIST"
echo "  log:    $LOG"
echo "  serves: http://127.0.0.1:$PORT  (boots idle — connect a generator from the UI's connect popover)"
echo "Stop/remove it any time with: $SCRIPT_DIR/uninstall-operator-service.sh"
