import assert from "node:assert/strict";
import test from "node:test";

import { flagLabel, levelRows } from "./scope.ts";
import { heroModel, levelCard, scopePill } from "./scopeView.ts";
import type { ScopeReading, ScopeStatus } from "./scope.ts";

const base: ScopeReading = {
  host_timestamp_ns: 1, level_w: 50, level_state: "assigned", setpoint_w: 50, forward_w: 50.5,
  vrms_v: 50.149, f0_hz: 13.56e6, resid_v: 0.67, vmin_v: -70, vmax_v: 72, h2_pct: 0.26, h3_pct: 0.14,
  b_pk_mt: 5.27, attn: 50, flags: "", valid: true,
};

test("scope view: no data is never shown as zeros", () => {
  const st = { status: { connected: false, error: "OSError: usb stall" }, latest: null } as unknown as ScopeStatus;
  assert.equal(heroModel(st).vrms.value, null);
  assert.equal(scopePill(st).kind, "error"); // design: an error is its own state, not "no data"
  assert.match(scopePill(st).detail ?? "", /usb stall/);
});

test("scope view: undefined scope (old backend) is no data", () => {
  assert.equal(heroModel(undefined).vrms.value, null);
  assert.match(scopePill(undefined).text, /no data/);
});

test("scope view: formats a live reading", () => {
  const st = { status: { connected: true, error: null, rate_hz: 2.1 }, latest: base } as unknown as ScopeStatus;
  const h = heroModel(st);
  assert.equal(h.vrms.value, "50.1"); // unit now rendered separately by the hero card
  assert.equal(h.b.value, "5.27");
  assert.equal(h.f0, "13.560");
  assert.equal(levelCard(st).big, "50 W");
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

test("scope view: stale snapshot is stalled, never live values", () => {
  const st = { status: { connected: true, error: null, rate_hz: 2.1 }, latest: base, stale: true } as unknown as ScopeStatus;
  const h = heroModel(st);
  assert.equal(scopePill(st).text, "stalled");
  assert.equal(h.vrms.value, null);
  assert.equal(h.b.value, null);
  assert.equal(h.f0, "—");
  assert.equal(h.pkpk, "—");
  assert.equal(h.h2, "—");
  assert.equal(levelCard(st).big, "—");
});
