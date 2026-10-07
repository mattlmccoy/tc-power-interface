import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { reflectedZone } from "./format.ts";
import type { LocateResult } from "./matchmap/locate.ts";
import {
  generatorSummary, matchAidSummary, matchNetSummary, matchTunerSummary, recordingSummary,
  rfPowerSummary, senseLoopSummary, summaryText, telemetrySummary, timerSummary,
} from "./panelSummaries.ts";
import type { ScopeReading, ScopeStatus } from "./scope.ts";
import type { Status } from "./telemetry.ts";

// Fixtures are GET /api/status captured from `tcp-serve --backend simulated` (2026-10-07):
//  idle  = fresh boot; live = caps 62/40 %, setpoint 30 W, RF on (auto-recording), timer + tuner running;
//  fault = reflected trip at caps 0/0 %. Only the experiments path was shortened to "/experiments".
const load = (k: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/status_${k}.json`, import.meta.url), "utf8")) as Status & {
    controller: { last_setpoint_w?: number | null };
  };
const idle = load("idle");
const live = load("live");
const fault = load("fault");

const zoneOf = (s: Status) => {
  const t = s.controller.telemetry;
  const max = s.controller.limits.max_reflected_w;
  return t ? reflectedZone(t.reverse_w, max * 0.5, max) : "ok";
};
const rfArgs = (s: ReturnType<typeof load>) => ({
  connected: s.controller.state === "connected" || s.controller.state === "fault",
  armed: s.controller.armed,
  faulted: s.controller.state === "fault",
  rfOn: s.controller.telemetry?.rf_on ?? null,
  setpointW: s.controller.last_setpoint_w,
  ramp: s.ramp,
});

// ---- telemetry ---------------------------------------------------------------------------
test("telemetry: live fwd (live tone) + refl with % (zone tone, none when ok)", () => {
  const segs = telemetrySummary(live.controller.telemetry, zoneOf(live));
  assert.equal(summaryText(segs), "fwd 30.0 W · refl 0.4 W (1.3 %)");
  assert.equal(segs[0].tone, "live");
  assert.equal(segs[1].tone, undefined);
});

test("telemetry: RF off → no live tone; forward 0 → no reflected % (backend writes 0, not a ratio)", () => {
  const segs = telemetrySummary(idle.controller.telemetry, zoneOf(idle));
  assert.equal(summaryText(segs), "fwd 0.0 W · refl 0.0 W");
  assert.equal(segs[0].tone, undefined);
});

test("telemetry: reflected zone colors refl; no telemetry is dashes, never 0", () => {
  const t = { ...live.controller.telemetry!, reverse_w: 20 };
  assert.equal(telemetrySummary(t, "warn")[1].tone, "warn");
  assert.equal(telemetrySummary(t, "trip")[1].tone, "trip");
  assert.equal(summaryText(telemetrySummary(null, "ok")), "fwd — · refl —");
});

// ---- RF power ----------------------------------------------------------------------------
test("rfpower: server setpoint, RF state, arm state", () => {
  const segs = rfPowerSummary(rfArgs(live));
  assert.equal(summaryText(segs), "set 30 W · RF on · armed");
  assert.equal(segs[1].tone, "live");
});

test("rfpower: no setpoint sent yet is a dash, not 0", () => {
  assert.equal(summaryText(rfPowerSummary(rfArgs(idle))), "set — · RF off · armed");
});

test("rfpower: fault replaces the arm state (trip); disconnected says so", () => {
  const segs = rfPowerSummary(rfArgs(fault));
  assert.equal(summaryText(segs), "set 30 W · RF off · FAULT");
  assert.equal(segs.at(-1)?.tone, "trip");
  const off = rfPowerSummary({ connected: false, armed: false, faulted: false, rfOn: null, setpointW: null });
  assert.equal(summaryText(off), "set — · disconnected");
  assert.equal(summaryText(rfPowerSummary({ ...rfArgs(live), armed: false })), "set 30 W · RF on · read-only");
});

test("rfpower: a running ramp shows its target", () => {
  const ramp = { ...live.ramp, running: true, target_w: 80 };
  assert.equal(summaryText(rfPowerSummary({ ...rfArgs(live), ramp })), "set 30 W · RF on · armed · ramp → 80 W");
});

// ---- generator (migrated from layout.ts) ------------------------------------------------
test("generator: temp + tempBar color; unknown is never 0 °C", () => {
  const segs = generatorSummary({ temperature_c: 41.2 }, { temperature_c_trip: 60 });
  assert.equal(summaryText(segs), "internal temp 41.2 °C");
  assert.match(segs[0].color ?? "", /^hsl\(/);
  assert.equal(summaryText(generatorSummary(null, { temperature_c_trip: 60 })), "internal temp —");
  assert.equal(generatorSummary(null, { temperature_c_trip: 60 })[0].color, undefined);
  assert.equal(generatorSummary({ temperature_c: 30 }, undefined)[0].color, undefined);
});

// ---- sense loop --------------------------------------------------------------------------
const settings = {
  resource: "USB0::0xF4EC::0xEE38::SDS1::INSTR", channel: 1, probe_attn: 500, core_label: "core 2",
  geometry: { turns: 1, cores_linked: 1, ae_per_core_m2: 1e-4 },
  limits: { probe_warn_v: 65, probe_hard_v: 70, flux_stop_mt: 6 },
};
const reading: ScopeReading = {
  host_timestamp_ns: 1_000_000_000, level_w: 30, level_state: "assigned", setpoint_w: 30,
  forward_w: 30.4, vrms_v: 40.42, f0_hz: 13.5601e6, resid_v: 0.41, vmin_v: -57, vmax_v: 58,
  h2_pct: 0.21, h3_pct: 0.09, b_pk_mt: 4.251, attn: 500, flags: "", valid: true,
};
const st = (over: Partial<ScopeStatus> = {}, r: Partial<ScopeReading> | null = {}): ScopeStatus => ({
  status: { running: true, connected: true, error: null, rate_hz: 4.13 },
  latest: r === null ? null : { ...reading, ...r }, settings, stale: false, ...over,
});

test("senseloop: assigned → V · B · level", () => {
  assert.equal(summaryText(senseLoopSummary(st())), "40.4 V · 4.25 mT · 30 W");
});

test("senseloop: RF off is blanked to the noise floor, never shown as a measurement", () => {
  const segs = senseLoopSummary(st({}, { level_state: "rf_off", level_w: null, vrms_v: 0.08, b_pk_mt: 0.004 }));
  assert.equal(summaryText(segs), "RF off · noise 0.1 V");
  assert.ok(!summaryText(segs).includes("mT"));
});

test("senseloop: invalid reading is blanked; its flags lead, colored by severity", () => {
  const segs = senseLoopSummary(st({}, { valid: false, flags: "clipped" }));
  assert.equal(summaryText(segs), "⚠ clipped · invalid reading");
  assert.equal(segs[0].tone, "trip");
});

test("senseloop: danger flags before caution flags; V/B colored by their meter zone", () => {
  const segs = senseLoopSummary(st({}, { flags: "probe_warn;flux_stop", vrms_v: 66.2, b_pk_mt: 6.3 }));
  assert.equal(summaryText(segs), "⚠ flux stop · ⚠ probe warn · 66.2 V · 6.30 mT · 30 W");
  assert.deepEqual(segs.map((s) => s.tone), ["trip", "warn", "warn", "trip", undefined]);
  assert.equal(senseLoopSummary(st({}, { vrms_v: 71 }))[0].tone, "trip");
});

test("senseloop: not yet assigned shows the level state word instead of a level", () => {
  assert.equal(summaryText(senseLoopSummary(st({}, { level_state: "settling", level_w: null }))),
    "40.4 V · 4.25 mT · settling");
});

test("senseloop: stalled / no data / error never show numbers", () => {
  assert.equal(summaryText(senseLoopSummary(st({ stale: true }))), "no data");
  assert.equal(senseLoopSummary(st({ stale: true }))[0].tone, "warn");
  assert.equal(summaryText(senseLoopSummary(st({}, null))), "no data");
  assert.equal(summaryText(senseLoopSummary(undefined)), "no data");
  assert.equal(summaryText(senseLoopSummary(idle.scope)), "no data"); // real: scope not connected
  const err = senseLoopSummary(st({ status: { connected: false, error: "OSError: usb stall" } }, null));
  assert.equal(summaryText(err), "scope error");
  assert.equal(err[0].tone, "trip");
});

// ---- matching network --------------------------------------------------------------------
test("matchnet: readback caps + mode; unknown is dashes", () => {
  assert.equal(summaryText(matchNetSummary(live.controller.telemetry)), "tune 62.0 % · load 40.0 % · manual");
  const auto = { ...live.controller.telemetry!, manual_mode: false };
  assert.equal(summaryText(matchNetSummary(auto)), "tune 62.0 % · load 40.0 % · auto");
  const old = { ...live.controller.telemetry!, tune_cap_percent: undefined, load_cap_percent: undefined, manual_mode: undefined };
  assert.equal(summaryText(matchNetSummary(old)), "tune — · load —");
  assert.equal(summaryText(matchNetSummary(null)), "tune — · load —");
});

// ---- match aid ---------------------------------------------------------------------------
const res = (over: Partial<LocateResult>): LocateResult => ({
  status: "spot", grid: { tune: [], load: [] }, cells: new Uint8Array(), estimate: { tune: 63, load: 40 },
  sigma: 0.02, worstGamma: 0.05, edge: false, ...over,
});
const MAP = {};

test("matchaid: the one-line suggestion, from the same cases as the panel message", () => {
  assert.equal(summaryText(matchAidSummary({ map: null, result: null, guidance: null })), "no map");
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: null, guidance: null })), "no reading");
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: res({ status: "none" }), guidance: null })), "no reading");
  const matched = matchAidSummary({ map: MAP, result: res({ status: "matched" }), guidance: null });
  assert.equal(summaryText(matched), "matched · hold");
  assert.equal(matched[0].tone, "live");
  const g = { tune: { dir: "up" as const, amount: 1.234 }, load: { dir: "hold" as const, amount: 0.1 } };
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: res({}), guidance: g })), "Tune ↑ 1.2 %");
  const both = { tune: { dir: "down" as const, amount: -2 }, load: { dir: "up" as const, amount: null } };
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: res({}), guidance: both })), "Tune ↓ 2.0 % · Load ↑");
  const hold = { tune: { dir: "hold" as const, amount: 0 }, load: { dir: "hold" as const, amount: 0 } };
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: res({}), guidance: hold })), "at match · hold");
  const nofit = matchAidSummary({ map: MAP, result: res({ status: "nofit" }), guidance: null });
  assert.equal(summaryText(nofit), "tune by hand");
  assert.equal(nofit[0].tone, "warn");
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: res({ edge: true, status: "ring" }), guidance: null })), "tune by hand");
  assert.equal(summaryText(matchAidSummary({ map: MAP, result: res({ status: "ring" }), guidance: null })), "need readings");
});

// ---- match tuner -------------------------------------------------------------------------
test("matchtuner: mode · phase · reverse while running; stopped otherwise", () => {
  assert.equal(summaryText(matchTunerSummary(live.match_tuner)), "advisory · searching · refl 1.3 %");
  assert.equal(summaryText(matchTunerSummary(idle.match_tuner)), "advisory · stopped");
  const armed = matchTunerSummary({ ...live.match_tuner, mode: "auto", armed: true, reverse_fraction: null });
  assert.equal(summaryText(armed), "auto · searching · armed");
  assert.equal(armed[2].tone, "warn");
  assert.equal(summaryText(matchTunerSummary(undefined)), "—");
});

// ---- timer -------------------------------------------------------------------------------
test("timer: running counts down (as the panel does), elapsed, off, unknown", () => {
  assert.equal(summaryText(timerSummary(live.timer)), "10 min left → RF off"); // 556.5 s
  assert.equal(summaryText(timerSummary({ ...live.timer, running: false, done: true })), "elapsed · RF off");
  assert.equal(summaryText(timerSummary(idle.timer)), "off");
  assert.equal(summaryText(timerSummary(undefined)), "—");
});

// ---- recording ---------------------------------------------------------------------------
test("recording: REC + elapsed since the run-dir stamp + the run's own name", () => {
  // live.recording.run = "20261007_145605_RF_20261007_145605" (recorder.py: "%Y%m%d_%H%M%S_<slug>", local time)
  const start = new Date(2026, 9, 7, 14, 56, 5).getTime();
  const segs = recordingSummary(live.recording, start + 761_000);
  assert.equal(summaryText(segs), "● REC 12:41 · RF_20261007_145605");
  assert.equal(segs[0].tone, "rec");
  assert.equal(summaryText(recordingSummary(live.recording, start + 3_725_000)), "● REC 1:02:05 · RF_20261007_145605");
});

test("recording: no elapsed when the stamp can't be read or the clocks disagree", () => {
  const start = new Date(2026, 9, 7, 14, 56, 5).getTime();
  assert.equal(summaryText(recordingSummary(live.recording, start - 60_000)), "● REC · RF_20261007_145605");
  assert.equal(summaryText(recordingSummary({ ...live.recording, run: "odd-name" }, start)), "● REC · odd-name");
  assert.equal(summaryText(recordingSummary({ ...live.recording, run: null }, start)), "● REC");
});

test("recording: idle and unknown", () => {
  assert.equal(summaryText(recordingSummary(idle.recording, Date.now())), "not recording");
  assert.equal(summaryText(recordingSummary(undefined, Date.now())), "—");
});
