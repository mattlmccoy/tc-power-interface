import assert from "node:assert/strict";
import test from "node:test";

import { flagLabel, levelRows, scopeHeadline } from "./scope.ts";
import type { ScopeReading, ScopeStatus } from "./scope.ts";

const base: ScopeReading = {
  host_timestamp_ns: 1, level_w: 50, level_state: "assigned", setpoint_w: 50, forward_w: 50.5,
  vrms_v: 50.149, f0_hz: 13.56e6, resid_v: 0.67, vmin_v: -70, vmax_v: 72, h2_pct: 0.26, h3_pct: 0.14,
  b_pk_mt: 5.27, attn: 50, flags: "", valid: true,
};

test("scopeHeadline: no data is never shown as zeros", () => {
  const st = { status: { connected: false, error: "OSError: usb stall" }, latest: null } as unknown as ScopeStatus;
  assert.equal(scopeHeadline(st).vrms, "—");
  assert.match(scopeHeadline(st).state, /no data/);
  assert.match(scopeHeadline(st).state, /usb stall/);
});

test("scopeHeadline: undefined scope (old backend) is no data", () => {
  assert.equal(scopeHeadline(undefined).vrms, "—");
  assert.match(scopeHeadline(undefined).state, /no data/);
});

test("scopeHeadline: formats a live reading", () => {
  const st = { status: { connected: true, error: null, rate_hz: 2.1 }, latest: base } as unknown as ScopeStatus;
  const h = scopeHeadline(st);
  assert.equal(h.vrms, "50.1 V");
  assert.equal(h.b, "5.27 mT");
  assert.equal(h.f0, "13.560 MHz");
  assert.equal(h.level, "50 W");
});

test("flagLabel: hard flags are loud", () => {
  assert.equal(flagLabel("flux_stop").severity, "danger");
  assert.equal(flagLabel("probe_warn").severity, "caution");
  assert.equal(flagLabel("seating").severity, "caution");
});

test("levelRows: accumulates per level from readings, ignores invalid/unassigned", () => {
  const rows = levelRows([base, { ...base, vrms_v: 50.3 }, { ...base, valid: false }, { ...base, level_w: null }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].level_w, 50);
});

test("scopeHeadline: stale snapshot is stalled, never live values", () => {
  const st = { status: { connected: true, error: null, rate_hz: 2.1 }, latest: base, stale: true } as unknown as ScopeStatus;
  const h = scopeHeadline(st);
  assert.equal(h.state, "scope: stalled — no fresh data");
  assert.equal(h.vrms, "—");
  assert.equal(h.b, "—");
  assert.equal(h.f0, "—");
  assert.equal(h.pkpk, "—");
  assert.equal(h.h2, "—");
  assert.equal(h.level, "—");
});
