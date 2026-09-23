// Reveal logic + commands for the site-mode "operator not running" panel.
//
// The page is served from GitHub Pages and talks to a LOCAL operator (default http://localhost:8010).
// When that operator isn't running there is nothing to talk to, so we show the user how to start it:
// an install one-liner (sets up an always-on service that starts at login) and a by-hand start command
// for when they just need it running now.

import { type Os, updateCommand } from "./update.ts";

export interface SetupHelpState {
  /** true only in the Pages build (VITE_SITE_MODE=1) — the operator-served copy is same-origin. */
  siteMode: boolean;
  /** the operator's telemetry WebSocket is currently open. */
  reachable: boolean;
  /** how many times the WS has failed to (re)connect since it was last open. */
  wsFails: number;
}

/** How many consecutive WS-connect failures before we reveal the panel. Two, so one transient close
 *  (e.g. an operator restart) doesn't flash the panel — it appears only on a real, sustained outage. */
export const WS_FAIL_THRESHOLD = 2;

/** Show the panel only in site mode, while the operator is unreachable, after the WS has failed to
 *  connect at least WS_FAIL_THRESHOLD times. Driven off the failure COUNT (never a setTimeout): a
 *  backgrounded tab throttles timers, so a timer-gated reveal can silently never fire. Re-evaluated
 *  every render, so it also hides the instant the operator connects. */
export function shouldShowSetupHelp({ siteMode, reachable, wsFails }: SetupHelpState): boolean {
  return siteMode && !reachable && wsFails >= WS_FAIL_THRESHOLD;
}

export interface SetupCommands {
  /** Where to paste the commands ("Terminal" / "PowerShell"). */
  shell: string;
  /** Install/repair one-liner: clones or updates the repo and (re)starts the always-on service. */
  install: string;
  /** Start the operator right now without the installer (see per-OS notes below). */
  start: string;
}

/** OS-appropriate commands for the panel, or null when there is no installer for this OS.
 *  - macOS: the launchd service is installed by install.sh; `kickstart -k` (re)starts it by label, so
 *    it works wherever the checkout lives.
 *  - Windows: runs the operator in the open PowerShell window from install.ps1's default checkout —
 *    works even if the scheduled task is missing, and any startup error is visible right there. */
export function setupCommands(os: Os): SetupCommands | null {
  const { command } = updateCommand(os);
  if (command === null) return null;
  if (os === "mac") {
    return {
      shell: "Terminal",
      install: command,
      start: "launchctl kickstart -k gui/$(id -u)/com.tcpower.operator",
    };
  }
  return {
    shell: "PowerShell",
    install: command,
    start:
      "cd $HOME\\tc-power-interface\\backend; uv run tcp-serve --host 127.0.0.1 --port 8010 --flir-url http://127.0.0.1:8000",
  };
}
