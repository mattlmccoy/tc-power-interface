import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { setupCommands, shouldShowSetupHelp } from "./setupHelp.ts";

const REPO_ROOT = new URL("../../../", import.meta.url);

test("shouldShowSetupHelp: shows in site mode when unreachable after >=2 WS failures", () => {
  assert.equal(shouldShowSetupHelp({ siteMode: true, reachable: false, wsFails: 2 }), true);
  assert.equal(shouldShowSetupHelp({ siteMode: true, reachable: false, wsFails: 3 }), true);
});

test("shouldShowSetupHelp: stays hidden until the second WS failure", () => {
  // Reveal off a COUNT, not a timer — one transient close must not flash the panel.
  assert.equal(shouldShowSetupHelp({ siteMode: true, reachable: false, wsFails: 0 }), false);
  assert.equal(shouldShowSetupHelp({ siteMode: true, reachable: false, wsFails: 1 }), false);
});

test("shouldShowSetupHelp: hides the instant the operator becomes reachable", () => {
  assert.equal(shouldShowSetupHelp({ siteMode: true, reachable: true, wsFails: 5 }), false);
});

test("shouldShowSetupHelp: never shows outside site mode", () => {
  assert.equal(shouldShowSetupHelp({ siteMode: false, reachable: false, wsFails: 9 }), false);
});

test("setupCommands(mac): Terminal install one-liner + a launchctl restart for an installed service", () => {
  const c = setupCommands("mac");
  assert.ok(c);
  assert.equal(c.shell, "Terminal");
  assert.equal(
    c.install,
    "curl -fsSL https://raw.githubusercontent.com/mattlmccoy/tc-power-interface/main/install.sh | bash",
  );
  assert.equal(c.start, "launchctl kickstart -k gui/$(id -u)/com.tcpower.operator");
});

test("setupCommands(windows): PowerShell install one-liner + a by-hand foreground start", () => {
  const c = setupCommands("windows");
  assert.ok(c);
  assert.equal(c.shell, "PowerShell");
  assert.equal(
    c.install,
    "irm https://raw.githubusercontent.com/mattlmccoy/tc-power-interface/main/install.ps1 | iex",
  );
  // The fallback runs the operator in the open window from the installer's default checkout, so it
  // works even if the scheduled task is missing — and any startup error is visible right there.
  assert.equal(
    c.start,
    "cd $HOME\\tc-power-interface\\backend; uv run tcp-serve --host 127.0.0.1 --port 8010 --flir-url http://127.0.0.1:8000",
  );
});

test("setupCommands: no installer for Linux/other -> null (panel shows a README note instead)", () => {
  assert.equal(setupCommands("linux"), null);
  assert.equal(setupCommands("other"), null);
});

test("data contract: every script the panel/banner advertises exists in the repo", () => {
  // Advertising a one-liner whose target isn't committed would 404 on raw.githubusercontent.com.
  for (const rel of ["install.sh", "install.ps1", "deploy/windows/run-operator.ps1"]) {
    assert.ok(existsSync(new URL(rel, REPO_ROOT)), `${rel} is advertised but missing from the repo`);
  }
});
