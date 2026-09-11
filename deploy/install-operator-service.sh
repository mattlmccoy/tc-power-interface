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
# FLIR run-logger base the operator posts RF edges + control/power telemetry to. Baked in at boot so
# the link is enabled+correct on every start (survives restarts) — a blank URL is the silent failure
# mode where nothing reaches FLIR. Override with TCP_FLIR_URL=... ; set to "" to boot with it off.
FLIR_URL="${TCP_FLIR_URL:-http://127.0.0.1:8000}"

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
        <string>--flir-url</string>
        <string>$FLIR_URL</string>
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
# bootout is ASYNC — bootstrapping the same label before the old job is fully torn down fails with
# "Input/output error" (5), leaving the service DOWN. So wait for the old job to disappear, then
# bootstrap with a couple of retries.
GUI="gui/$(id -u)"
launchctl bootout "$GUI/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$GUI/$LABEL" >/dev/null 2>&1 || break  # gone -> safe to bootstrap
  sleep 0.5
done
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "$GUI" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null; then
    break
  fi
  echo "  (launchctl load attempt $attempt failed; retrying…)" >&2
  sleep 1
done

echo "Installed + started $LABEL"
echo "  plist:  $PLIST"
echo "  log:    $LOG"
echo "  serves: http://127.0.0.1:$PORT  (boots idle — connect a generator from the UI's connect popover)"
echo "Stop/remove it any time with: $SCRIPT_DIR/uninstall-operator-service.sh"
