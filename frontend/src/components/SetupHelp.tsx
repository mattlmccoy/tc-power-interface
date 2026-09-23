import { useState } from "react";

import { setupCommands } from "../lib/setupHelp.ts";
import { detectOs } from "../lib/update.ts";

interface SetupHelpProps {
  /** The operator address this page is trying to reach (for display). */
  operatorBase: string;
  /** The existing site-mode operator-address override state (reused, not re-created). */
  baseInput: string;
  setBaseInput: (v: string) => void;
  applyBase: () => void;
}

/** One copyable command line. */
function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the command stays selectable in the box */
    }
  };
  return (
    <div className="setup-cmd">
      <code className="setup-cmd-text">{command}</code>
      <button className="btn accent setup-cmd-copy" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Site-mode panel shown when the local operator isn't reachable (e.g. after a reboot on a machine
 *  without the auto-start service). Shows the OS-appropriate install one-liner — which sets up an
 *  always-on service — and a by-hand start command. Rendered IN PLACE of the tab views (App.tsx). */
export function SetupHelp({ operatorBase, baseInput, setBaseInput, applyBase }: SetupHelpProps) {
  const os = detectOs(navigator.userAgent);
  const cmds = setupCommands(os);
  return (
    <div className="setup-help">
      <div className="panel setup-card">
        <span className="setup-status">
          <span className="dot" />
          operator offline
        </span>
        <h1>The operator isn&apos;t running on this computer</h1>
        <p className="setup-note">
          This page runs from the web, but it drives the generator through a small{" "}
          <strong>operator</strong> program on <strong>this computer</strong> — at{" "}
          <code>{operatorBase}</code> — and it isn&apos;t responding. Start it with one of these, in{" "}
          <strong>{cmds ? cmds.shell : "a terminal"}</strong>. This page reconnects on its own.
        </p>

        {cmds ? (
          <>
            <div className="field-label">Install &amp; auto-start (recommended)</div>
            <CommandRow command={cmds.install} />
            <p className="setup-note">
              {os === "windows"
                ? "Sets up a background task that starts when you log in and restarts the operator if it stops, so a reboot no longer kills it. Needs git and uv. Safe to re-run any time — it also updates the operator."
                : "Sets up a background service that starts when you log in and restarts the operator if it stops. Safe to re-run any time — it also updates the operator."}
            </p>

            <div className="field-label">Or start it right now</div>
            <CommandRow command={cmds.start} />
            <p className="setup-note">
              {os === "windows"
                ? "Runs the operator in this PowerShell window — keep the window open. Uses the installer's default folder ($HOME\\tc-power-interface); any startup error shows right there."
                : "Restarts the installed service. If it says the service can't be found, run the install command above."}
            </p>
          </>
        ) : (
          <p className="setup-note">
            There&apos;s no one-command installer for this operating system — see the project README to
            start the operator.
          </p>
        )}

        <div className="field-label">Already running it elsewhere?</div>
        <div className="connect-row">
          <input
            value={baseInput}
            onChange={(e) => setBaseInput(e.target.value)}
            placeholder="http://localhost:8010"
            spellCheck={false}
          />
          <button className="btn" onClick={applyBase}>
            Use this address
          </button>
        </div>
        <p className="setup-note">Point the page at an operator on another host or port.</p>
      </div>
    </div>
  );
}
