import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { requestedFromStatus } from "./power.ts";
import type { Status } from "./telemetry.ts";

// Captured GET /api/status fixtures (see panelSummaries.test.ts): idle = fresh boot (no setpoint
// written yet → last_setpoint_w null); live = 30 W written to the generator.
const load = (k: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/status_${k}.json`, import.meta.url), "utf8")) as Status;

test("requestedFromStatus: the setpoint last written to the generator (captured live status)", () => {
  assert.equal(requestedFromStatus(load("live")), 30);
});

test("requestedFromStatus: unknown (fresh connect / link loss) is null, not 0", () => {
  assert.equal(requestedFromStatus(load("idle")), null);
  assert.equal(requestedFromStatus(null), null);
  assert.equal(requestedFromStatus(undefined), null);
});

test("requestedFromStatus: a commanded 0 W is a real value, not unknown", () => {
  const s = load("live");
  assert.equal(requestedFromStatus({ ...s, controller: { ...s.controller, last_setpoint_w: 0 } }), 0);
});

test("requestedFromStatus: falls back to the commanded_setpoint_w alias (closed-loop cockpit backend)", () => {
  const s = load("idle");
  const ctrl = { ...s.controller, last_setpoint_w: undefined, commanded_setpoint_w: 40 };
  assert.equal(requestedFromStatus({ ...s, controller: ctrl }), 40);
});

test("requestedFromStatus: a non-finite value is unknown", () => {
  const s = load("live");
  assert.equal(requestedFromStatus({ ...s, controller: { ...s.controller, last_setpoint_w: Number.NaN } }), null);
});
