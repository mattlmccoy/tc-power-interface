import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { requestedW } from "./power.ts";
import type { Status } from "./telemetry.ts";

// Captured GET /api/status fixtures (see panelSummaries.test.ts): idle = fresh boot (no setpoint
// written yet → null); live = 30 W written to the generator. Both predate commanded_setpoint_w, so
// they are also what an older (pre-v0.18) operator sends.
const ctrlOf = (k: string) =>
  (JSON.parse(readFileSync(new URL(`./fixtures/status_${k}.json`, import.meta.url), "utf8")) as Status).controller;

test("requestedW: the setpoint last written to the generator (captured live status)", () => {
  assert.equal(requestedW(ctrlOf("live")), 30);
});

test("requestedW: reads commanded_setpoint_w (v0.18+ operator)", () => {
  assert.equal(requestedW({ commanded_setpoint_w: 70 }), 70);
});

test("requestedW: falls back to last_setpoint_w (older operator without commanded_setpoint_w)", () => {
  assert.equal(requestedW({ last_setpoint_w: 30 }), 30);
});

test("requestedW: unknown (fresh connect / link loss) is null, not 0", () => {
  assert.equal(requestedW(ctrlOf("idle")), null);
  assert.equal(requestedW({ commanded_setpoint_w: null, last_setpoint_w: null }), null);
  assert.equal(requestedW({}), null);
  assert.equal(requestedW(null), null);
  assert.equal(requestedW(undefined), null);
});

test("requestedW: a commanded 0 W is a real value, not unknown", () => {
  assert.equal(requestedW({ commanded_setpoint_w: 0, last_setpoint_w: 0 }), 0);
});

test("requestedW: a non-finite value is unknown", () => {
  assert.equal(requestedW({ commanded_setpoint_w: Number.NaN }), null);
  assert.equal(requestedW({ last_setpoint_w: Number.NaN }), null);
});
