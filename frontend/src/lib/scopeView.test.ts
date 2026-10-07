import assert from "node:assert/strict";
import test from "node:test";

import type { ScopeReading, ScopeStatus } from "./scope.ts";
import {
  advanceScopeHistory, appendSample, autoOpenSettings, configSummary, flagBanners, heroModel, levelCard, levelTable,
  recordingDownloads, scopePill, trendSeries,
} from "./scopeView.ts";

// Shapes mirror backend/tc_power_interface/integration/scope_hub.py snapshot()/on_reading() and
// ScopeSettings/ScopeLimits/LoopGeometry defaults (scope_settings.py, analysis/flux.py).
const settings = {
  resource: "USB0::0xF4EC::0xEE38::SDS1::INSTR", channel: 1, probe_attn: 500, core_label: "core 2",
  geometry: { turns: 1, cores_linked: 1, ae_per_core_m2: 1e-4 },
  limits: { probe_warn_v: 65, probe_hard_v: 70, flux_stop_mt: 6 },
};

const live: ScopeReading = {
  host_timestamp_ns: 1_000_000_000, level_w: 30, level_state: "assigned", setpoint_w: 30,
  forward_w: 30.4, vrms_v: 40.42, f0_hz: 13.5601e6, resid_v: 0.41, vmin_v: -57, vmax_v: 58,
  h2_pct: 0.21, h3_pct: 0.09, b_pk_mt: 4.251, attn: 500, flags: "", valid: true,
};

const st = (over: Partial<ScopeStatus> = {}, latest: ScopeReading | null = live): ScopeStatus => ({
  status: { running: true, connected: true, error: null, rate_hz: 4.13 },
  latest, settings, stale: false, ...over,
});

// ---- status pill -------------------------------------------------------------------------
test("scopePill: live shows rate and the connected style", () => {
  const p = scopePill(st());
  assert.equal(p.kind, "live");
  assert.equal(p.cls, "connected");
  assert.equal(p.text, "live · 4.1 Hz");
});

test("scopePill: stale is stalled (warn), never live", () => {
  const p = scopePill(st({ stale: true }, null));
  assert.equal(p.kind, "stalled");
  assert.equal(p.cls, "warn");
  assert.equal(p.text, "stalled");
});

test("scopePill: error is fault with the error text as detail", () => {
  const p = scopePill(st({ status: { running: true, connected: false, error: "OSError: usb stall" } }, null));
  assert.equal(p.kind, "error");
  assert.equal(p.cls, "fault");
  assert.equal(p.detail, "OSError: usb stall");
});

test("scopePill: undefined (old backend) and disconnected are no data", () => {
  assert.equal(scopePill(undefined).kind, "nodata");
  const p = scopePill(st({ status: { running: false, connected: false, error: null } }, null));
  assert.equal(p.kind, "nodata");
  assert.equal(p.cls, "disconnected");
  assert.equal(p.text, "no data");
});

// ---- config summary / drawer -------------------------------------------------------------
test("configSummary: core label, turns, cores, probe ×", () => {
  assert.equal(configSummary(settings), "core 2 · 1 turn · 1 core · probe 500×");
  const many = { ...settings, geometry: { turns: 3, cores_linked: 2 } };
  assert.equal(configSummary(many), "core 2 · 3 turns · 2 cores · probe 500×");
  assert.equal(configSummary(undefined), "");
});

test("autoOpenSettings: opens with no resource or on error, else closed", () => {
  assert.equal(autoOpenSettings(st()), false);
  assert.equal(autoOpenSettings(st({ settings: { ...settings, resource: "" } })), true);
  assert.equal(autoOpenSettings(undefined), true);
  assert.equal(autoOpenSettings(st({ status: { connected: false, error: "boom" } }, null)), true);
});

// ---- hero model + blanking ---------------------------------------------------------------
test("heroModel: live assigned reading formats every value", () => {
  const h = heroModel(st());
  assert.equal(h.blank, null);
  assert.equal(h.vrms.value, "40.4");
  assert.equal(h.b.value, "4.25");
  assert.equal(h.f0, "13.560");
  assert.equal(h.pkpk, "115 V");
  assert.equal(h.h2, "0.21 %");
  assert.equal(h.h3, "0.09 %");
  assert.equal(h.resid, "0.41 V");
});

test("heroModel: RF off never renders fitted noise as measurements", () => {
  const rfOff = { ...live, level_w: null, level_state: "rf_off", vrms_v: 0.04, b_pk_mt: 0.004,
    f0_hz: 13.62e6, h2_pct: 42.54, vmin_v: -0.5, vmax_v: 0.5 };
  const h = heroModel(st({}, rfOff));
  assert.equal(h.blank, "RF off");
  assert.equal(h.vrms.value, null);
  assert.equal(h.vrms.note, "noise floor 0.0 V");
  for (const v of [h.b.value, h.f0, h.pkpk, h.h2, h.h3, h.resid]) assert.equal(v, "—");
  assert.equal(h.vMeter.frac, null);
  assert.equal(h.bMeter.frac, null);
});

test("heroModel: invalid reading blanks everything with an 'invalid' tag", () => {
  const bad = { ...live, valid: false, flags: "clipped" };
  const h = heroModel(st({}, bad));
  assert.equal(h.blank, "invalid");
  assert.equal(h.vrms.value, null);
  assert.equal(h.vrms.note, "invalid reading");
  for (const v of [h.b.value, h.f0, h.pkpk, h.h2, h.h3, h.resid]) assert.equal(v, "—");
});

test("heroModel: RF off with no fit shows a dash, not a noise floor", () => {
  const h = heroModel(st({}, { ...live, level_state: "rf_off", vrms_v: null, valid: false }));
  assert.equal(h.vrms.value, null);
  assert.equal(h.vrms.note, null);
});

test("heroModel: stalled / no data / undefined are all dashes", () => {
  for (const s of [st({ stale: true }, live), st({}, null), undefined]) {
    const h = heroModel(s);
    assert.equal(h.vrms.value, null);
    assert.equal(h.b.value, null);
    for (const v of [h.f0, h.pkpk, h.h2, h.h3, h.resid]) assert.equal(v, "—");
    assert.equal(h.vMeter.frac, null);
  }
});

// ---- meters ------------------------------------------------------------------------------
test("heroModel: V meter spans 0..hard*1.1 with warn/hard marks and zones", () => {
  const m = heroModel(st()).vMeter;
  assert.ok(Math.abs((m.frac as number) - 40.42 / 77) < 1e-9);
  assert.equal(m.zone, "live");
  assert.deepEqual(m.marks.map((k) => k.cls), ["warn", "err"]);
  assert.ok(Math.abs(m.marks[0].frac - 65 / 77) < 1e-9);
  assert.ok(Math.abs(m.marks[1].frac - 70 / 77) < 1e-9);
  assert.equal(m.legend, "probe 65 / 70 V");
  assert.equal(heroModel(st({}, { ...live, vrms_v: 66 })).vMeter.zone, "warn");
  assert.equal(heroModel(st({}, { ...live, vrms_v: 70 })).vMeter.zone, "trip");
  assert.equal(heroModel(st({}, { ...live, vrms_v: 500 })).vMeter.frac, 1);
});

test("heroModel: B meter spans 0..stop*1.33 with a stop mark", () => {
  const m = heroModel(st()).bMeter;
  assert.ok(Math.abs((m.frac as number) - 4.251 / (6 * 1.33)) < 1e-9);
  assert.equal(m.zone, "live");
  assert.equal(m.marks.length, 1);
  assert.equal(m.marks[0].cls, "err");
  assert.equal(m.legend, "stop 6.0 mT");
  assert.equal(heroModel(st({}, { ...live, b_pk_mt: 6.1 })).bMeter.zone, "trip");
});

// ---- level card --------------------------------------------------------------------------
test("levelCard: assigned shows the level, state + fwd, and V/√W", () => {
  const c = levelCard(st());
  assert.equal(c.big, "30 W");
  assert.equal(c.assigned, true);
  assert.equal(c.sub, "assigned · fwd 30.4 W");
  assert.equal(c.vps, "7.38 V/√W");
});

test("levelCard: unassigned shows the state word and no V/√W", () => {
  const c = levelCard(st({}, { ...live, level_w: null, level_state: "off_setpoint" }));
  assert.equal(c.big, "off setpoint");
  assert.equal(c.assigned, false);
  assert.equal(c.vps, null);
  assert.equal(levelCard(st({}, { ...live, level_w: null, level_state: "rf_off", forward_w: 0 })).big, "RF off");
  assert.equal(levelCard(st({}, { ...live, level_w: null, level_state: "settling" })).sub, "settling · fwd 30.4 W");
});

test("levelCard: invalid assigned reading hides V/√W; no data is a dash", () => {
  assert.equal(levelCard(st({}, { ...live, valid: false })).vps, null);
  assert.equal(levelCard(undefined).big, "—");
  assert.equal(levelCard(st({ stale: true }, live)).big, "—");
});

// ---- trend -------------------------------------------------------------------------------
test("appendSample: dedupes by host_timestamp_ns and blanks RF-off / invalid readings", () => {
  let buf = appendSample([], live, 10);
  buf = appendSample(buf, live, 10);
  assert.equal(buf.length, 1);
  buf = appendSample(buf, { ...live, host_timestamp_ns: 2e9, level_state: "rf_off" }, 10);
  buf = appendSample(buf, { ...live, host_timestamp_ns: 3e9, valid: false }, 10);
  assert.deepEqual(buf.map((s) => [s.v, s.b]), [[40.42, 4.251], [null, null], [null, null]]);
  for (let i = 4; i < 20; i++) buf = appendSample(buf, { ...live, host_timestamp_ns: i * 1e9 }, 10);
  assert.equal(buf.length, 10);
  assert.equal(appendSample(buf, null, 10), buf);
});

// ---- lifted history (survives the Dashboard <-> Closed-loop tab switch) -----------------------
const EMPTY = { samples: [], readings: [] };
const CAPS = { samples: 10, readings: 3 };

test("advanceScopeHistory: appends a new reading to both buffers, dedupes a repeat by timestamp", () => {
  const h1 = advanceScopeHistory(EMPTY, st(), CAPS);
  assert.equal(h1.samples.length, 1);
  assert.equal(h1.readings.length, 1);
  assert.equal(advanceScopeHistory(h1, st(), CAPS), h1); // same object back = no re-render
});

test("advanceScopeHistory: RF-off / invalid readings are kept but blanked in the trend samples", () => {
  let h = advanceScopeHistory(EMPTY, st(), CAPS);
  h = advanceScopeHistory(h, st({}, { ...live, host_timestamp_ns: 2e9, level_state: "rf_off" }), CAPS);
  assert.deepEqual(h.samples.map((s) => [s.v, s.b]), [[40.42, 4.251], [null, null]]);
  assert.equal(h.readings.length, 2);
});

test("advanceScopeHistory: a stale scope adds no trend sample (but the reading table still tracks latest)", () => {
  const h0 = advanceScopeHistory(EMPTY, st(), CAPS);
  const h = advanceScopeHistory(h0, st({ stale: true }, { ...live, host_timestamp_ns: 2e9 }), CAPS);
  assert.equal(h.samples.length, 1);
  assert.equal(h.readings.length, 2);
});

test("advanceScopeHistory: no scope / no latest reading leaves the history untouched", () => {
  const h = advanceScopeHistory(EMPTY, st(), CAPS);
  assert.equal(advanceScopeHistory(h, undefined, CAPS), h);
  assert.equal(advanceScopeHistory(h, st({}, null), CAPS), h);
});

test("advanceScopeHistory: caps both buffers, dropping the oldest", () => {
  let h = EMPTY as ReturnType<typeof advanceScopeHistory>;
  for (let i = 1; i <= 20; i++) h = advanceScopeHistory(h, st({}, { ...live, host_timestamp_ns: i * 1e9 }), CAPS);
  assert.equal(h.samples.length, 10);
  assert.equal(h.readings.length, 3);
  assert.deepEqual(h.readings.map((r) => r.host_timestamp_ns), [18e9, 19e9, 20e9]);
});

test("trendSeries: keeps the window, breaks lines at time gaps with nulls", () => {
  const s = (t: number, v: number | null) => ({ t_ns: t * 1e9, v, b: v });
  const buf = [s(0, 1), s(100, 2), s(101, 3), s(200, 4), s(201, null), s(202, 5)];
  const out = trendSeries(buf, 202e9, 150, 3);
  assert.deepEqual(out.map((p) => [p.t, p.v]), [
    [-102, 2], [-101, 3], [-51.5, null], [-2, 4], [-1, null], [0, 5],
  ]);
});

// ---- level table -------------------------------------------------------------------------
test("levelTable: aligned strings incl. V/√W and H2, active row marked", () => {
  const mk = (lvl: number, v: number, b: number, t: number) =>
    ({ ...live, level_w: lvl, vrms_v: v, b_pk_mt: b, host_timestamp_ns: t, h2_pct: 0.2 });
  const rows = levelTable([mk(30, 40.4, 4.25, 3), mk(10, 26.6, 2.8, 1), mk(15, 30.8, 3.23, 2)], 30);
  assert.deepEqual(rows.map((r) => r.level), ["10 W", "15 W", "30 W"]);
  assert.deepEqual(rows.map((r) => r.active), [false, false, true]);
  assert.equal(rows[2].vrms, "40.4");
  assert.equal(rows[2].vps, "7.38");
  assert.equal(rows[2].b, "4.25");
  assert.equal(rows[2].h2, "0.20");
  assert.equal(rows[0].n, "1");
  assert.equal(levelTable([], null).length, 0);
});

// ---- flags -------------------------------------------------------------------------------
test("flagBanners: danger first, then caution", () => {
  const b = flagBanners("probe_warn;seating;flux_stop");
  assert.deepEqual(b.map((x) => x.severity), ["danger", "caution", "caution"]);
  assert.equal(flagBanners("").length, 0);
  assert.equal(flagBanners(undefined).length, 0);
});

// ---- recording downloads -----------------------------------------------------------------
test("recordingDownloads: shows scope.csv only when the run's files list has it", () => {
  assert.deepEqual(recordingDownloads(["telemetry.csv", "scope.csv", "scope_levels.csv"]), { scope: true });
  assert.deepEqual(recordingDownloads(["telemetry.csv"]), { scope: false });
  assert.deepEqual(recordingDownloads(null), { scope: false });
});
