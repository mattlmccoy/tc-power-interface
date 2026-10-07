import assert from "node:assert/strict";
import { test } from "node:test";

import type { Status } from "../telemetry.ts";
import { sampleFromStatus } from "./history.ts";

// Captured from the simulated operator (`GET :8011/api/status`, 2026-10-07), trimmed to the blocks
// the sampler reads. The `watch` entries follow backend control/core_watch.py:47-60 (the simulator
// has no FLIR roster, so it never emits any): "ok" with a value, "not_in_feed"/"invalid" with nulls.
const CAPTURED = {
  device: { id: "AG 0613", serial: "SIM-0001", power_limit_w: 600.0 },
  controller: {
    state: "connected",
    armed: true,
    commanded_setpoint_w: null,
    fault_reasons: [],
    warnings: [],
    telemetry: {
      host_timestamp_ns: 1791397669392947000,
      forward_w: 0.0,
      reverse_w: 0.0,
      load_w: 0.0,
      reflected_fraction: 0.0,
      rf_on: false,
      temperature_c: 30.0,
      operation_mode: "normal",
      tuner: "analog tuner",
      status: 0,
      manual_mode: true,
      tune_cap_percent: 0.0,
      load_cap_percent: 0.0,
    },
  },
  recording: { active: false, run: null },
  thermal: {
    control_temp_c: 25.0,
    temp_status: "simulated",
    shadow: { suggest_w: null },
    watch: [],
  },
} as unknown as Status;

const withWatch = (watch: unknown[]): Status =>
  ({ ...CAPTURED, thermal: { ...CAPTURED.thermal, watch } }) as unknown as Status;

test("no status or no telemetry -> no sample", () => {
  assert.equal(sampleFromStatus(null), null);
  const noTel = { ...CAPTURED, controller: { ...CAPTURED.controller, telemetry: null } } as unknown as Status;
  assert.equal(sampleFromStatus(noTel), null);
});

test("maps the captured simulator status", () => {
  assert.deepEqual(sampleFromStatus(CAPTURED), {
    ns: 1791397669392947000,
    run: null,
    rf: false,
    fwd: 0,
    rev: 0,
    part: 25,
    watch: {},
    suggest: null,
    tune: 0,
    load: 0,
  });
});

test("run, suggestion and watched temperatures; a dark watch ROI is null, never 0", () => {
  const st = withWatch([
    { name: "toroid_C", temp_c: 41.5, rate_c_per_min: 0.8, status: "ok" },
    { name: "toroid_D", temp_c: null, rate_c_per_min: null, status: "not_in_feed" },
  ]);
  const s2 = {
    ...st,
    recording: { active: true, run: "20261007_101500_ladder" },
    thermal: { ...st.thermal, shadow: { suggest_w: 72.4 } },
  } as unknown as Status;
  const out = sampleFromStatus(s2)!;
  assert.equal(out.run, "20261007_101500_ladder");
  assert.equal(out.suggest, 72.4);
  assert.deepEqual(out.watch, { toroid_C: 41.5, toroid_D: null });
});

test("missing optional blocks (older operator) are unknown, not 0", () => {
  const old = {
    controller: {
      telemetry: { host_timestamp_ns: 5, forward_w: 10, reverse_w: 0.2, rf_on: true },
    },
    thermal: { control_temp_c: null },
  } as unknown as Status;
  assert.deepEqual(sampleFromStatus(old), {
    ns: 5, run: null, rf: true, fwd: 10, rev: 0.2, part: null, watch: {}, suggest: null, tune: null, load: null,
  });
});
