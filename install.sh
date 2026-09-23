#!/usr/bin/env bash
# One-command installer for the TC-POWER operator (the local generator server the web UI talks to).
#
#   curl -fsSL https://raw.githubusercontent.com/mattlmccoy/tc-power-interface/main/install.sh | bash
#
# Clones (or updates) this repo and installs the operator as an always-on macOS background service:
# it starts at login, restarts if it dies, and is always reachable at http://127.0.0.1:8010 — so the
# hosted UI (GitHub Pages) and the local UI always find it. Reversible: run
# deploy/uninstall-operator-service.sh in the cloned repo.
#
# macOS (the service is a launchd LaunchAgent; Windows uses install.ps1). Re-running it updates the
# checkout the installed service already runs from; a first install clones to ~/tc-power-interface.
# Override with TCP_DIR=/path. The operator boots idle — attach the generator from the connect popover.
set -euo pipefail

REPO_URL="https://github.com/mattlmccoy/tc-power-interface.git"
PLIST="$HOME/Library/LaunchAgents/com.tcpower.operator.plist"

fail() { echo "error: $*" >&2; exit 1; }

# Where to install/update. TCP_DIR wins. Otherwise, if the service is ALREADY installed, update the
# checkout it runs from — re-running this is the "update" command, and it must not quietly move the
# service to a new clone (which also moves where runs are logged and drops a locally built UI).
# Only a first install defaults to ~/tc-power-interface.
existing_checkout() {
  [[ -f "$PLIST" ]] || return 1
  local wd
  wd=$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$PLIST" 2>/dev/null) || return 1
  git -C "$wd" rev-parse --show-toplevel 2>/dev/null
}
if [[ -n "${TCP_DIR:-}" ]]; then
  DEST="$TCP_DIR"
elif DEST="$(existing_checkout)" && [[ -n "$DEST" ]]; then
  echo "Found the installed operator service; updating its checkout at $DEST"
else
  DEST="$HOME/tc-power-interface"
fi

[[ "$(uname -s)" == "Darwin" ]] || fail "this installer supports macOS only (the operator service is a launchd LaunchAgent)."
command -v git >/dev/null 2>&1 || fail "'git' not found. Install the Xcode command line tools: xcode-select --install"
command -v uv  >/dev/null 2>&1 || fail "'uv' not found. Install it first: https://docs.astral.sh/uv/  (curl -LsSf https://astral.sh/uv/install.sh | sh)"

if [[ -d "$DEST/.git" ]]; then
  echo "Updating existing checkout at $DEST ..."
  git -C "$DEST" pull --ff-only
else
  echo "Cloning $REPO_URL -> $DEST ..."
  git clone --depth 1 "$REPO_URL" "$DEST"
fi

INSTALLER="$DEST/deploy/install-operator-service.sh"
[[ -x "$INSTALLER" ]] || fail "service installer not found at $INSTALLER (unexpected repo layout)."

echo "Installing the always-on operator service ..."
"$INSTALLER"

echo
echo "Done. The operator is running at http://127.0.0.1:8010 and will restart at login."
echo "Reload the web page — it reconnects automatically."
