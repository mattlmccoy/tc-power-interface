import assert from "node:assert/strict";
import test from "node:test";

import { detectOs, operatorBehind, updateCommand } from "./update.ts";

test("operatorBehind: true only when the operator is strictly older and both versions parse", () => {
  assert.equal(operatorBehind("0.2.0", "0.8.3"), true);
  assert.equal(operatorBehind("0.8.3", "0.8.3"), false); // equal
  assert.equal(operatorBehind("0.9.0", "0.8.3"), false); // operator ahead
  assert.equal(operatorBehind("0.8.10", "0.8.3"), false); // numeric, not string: 10 > 3
});

test("operatorBehind: never nags on unknown/unparseable versions", () => {
  assert.equal(operatorBehind(null, "0.8.3"), false);
  assert.equal(operatorBehind(undefined, "0.8.3"), false);
  assert.equal(operatorBehind("dev", "0.8.3"), false);
  assert.equal(operatorBehind("", "0.8.3"), false);
  assert.equal(operatorBehind("0.8.3", "dev"), false);
});

test("detectOs: classifies mac / windows / linux / other", () => {
  assert.equal(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"), "mac");
  assert.equal(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64)"), "windows");
  assert.equal(detectOs("Mozilla/5.0 (X11; Linux x86_64)"), "linux");
  assert.equal(detectOs("some weird agent"), "other");
});

test("updateCommand: macOS gets the install.sh one-liner", () => {
  const c = updateCommand("mac");
  assert.ok(c.command);
  assert.match(c.command as string, /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/mattlmccoy\/tc-power-interface\/main\/install\.sh \| bash$/);
});

test("updateCommand: Windows gets the install.ps1 one-liner (re-running it updates + restarts)", () => {
  const c = updateCommand("windows");
  assert.equal(
    c.command,
    "irm https://raw.githubusercontent.com/mattlmccoy/tc-power-interface/main/install.ps1 | iex",
  );
  assert.match(c.label, /PowerShell/);
});

test("updateCommand: Linux/other get a manual note, NOT a command (no installer for them)", () => {
  for (const os of ["linux", "other"] as const) {
    assert.equal(updateCommand(os).command, null);
    assert.ok(updateCommand(os).label); // still labels the OS for the manual-update note
  }
});
