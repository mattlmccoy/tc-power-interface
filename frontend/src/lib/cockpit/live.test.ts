import assert from "node:assert/strict";
import { test } from "node:test";

import type { CockpitSample } from "./history.ts";
import { matchStatus, partRate, retuneNs, runStats, toggleWatch, tttText, WATCH_DEFAULTS } from "./live.ts";
import type { Shadow } from "./shadowText.ts";

const S = 1e9; // ns per second
const smp = (tS: number, o: Partial<CockpitSample> = {}): CockpitSample => ({
  ns: tS * S, run: "r1", rf: true, fwd: 50, rev: 0.1, part: 30, watch: {}, suggest: null, tune: 20, load: 10, ...o,
});

test("partRate: °C/min over the last 60 s, null until 30 s of finite readings", () => {
  assert.equal(partRate([]), null);
  assert.equal(partRate([smp(0), smp(20, { part: 40 })]), null); // only 20 s span
  const buf = [smp(0, { part: 10 }), smp(30, { part: 20 }), smp(60, { part: 30 }), smp(90, { part: 40 })];
  // window = last 60 s -> from t=30 (20 °C) to t=90 (40 °C): 20 °C per minute
  assert.equal(partRate(buf), 20);
  // unknown readings are skipped, not read as 0
  const gaps = [smp(0, { part: 10 }), smp(30, { part: null }), smp(40, { part: 12 })];
  assert.equal(partRate(gaps), 3);
  assert.equal(partRate([smp(0, { part: null }), smp(60, { part: null })]), null);
});

test("runStats: not recording -> null; elapsed + forward energy over the current run's samples", () => {
  assert.equal(runStats([smp(0, { run: null })], null), null);
  assert.equal(runStats([], "r1"), null);
  const buf = Array.from({ length: 101 }, (_, i) => smp(i, { fwd: 36 })); // 1 s cadence
  const st = runStats(buf, "r1")!;
  assert.equal(st.elapsedS, 100);
  assert.ok(Math.abs(st.energyWh - 1) < 1e-9); // 36 W * 100 s = 3600 J
  assert.equal(st.since, "page open"); // never saw the run start
});

test("runStats: a gap over 5 s (link lost) adds no energy; seeing null -> run means since recording start", () => {
  const buf = [smp(0, { run: null }), smp(1, { fwd: 3600 }), smp(2, { fwd: 3600 }), smp(60, { fwd: 3600 })];
  const st = runStats(buf, "r1")!;
  assert.equal(st.since, "recording start");
  assert.equal(st.elapsedS, 59);
  assert.equal(st.energyWh, 1); // only 1 → 2 s counts
});

test("matchStatus: tiers by reflected % of forward, RF off and no telemetry are not 'matched'", () => {
  assert.deepEqual(matchStatus(null), { chip: "—", text: "No telemetry.", tone: "muted" });
  assert.deepEqual(matchStatus({ rf_on: false, forward_w: 0, reverse_w: 0 }), { chip: "RF off", text: "RF off", tone: "muted" });
  assert.equal(matchStatus({ rf_on: true, forward_w: 0.5, reverse_w: 0 }).tone, "muted");
  assert.deepEqual(matchStatus({ rf_on: true, forward_w: 100, reverse_w: 0.25 }), { chip: "0.3 % reflected", text: "Matched. Hold.", tone: "ok" });
  assert.deepEqual(matchStatus({ rf_on: true, forward_w: 100, reverse_w: 0.9 }), { chip: "0.9 % reflected", text: "Close: reflected below 1 %.", tone: "ok" });
  assert.deepEqual(matchStatus({ rf_on: true, forward_w: 100, reverse_w: 2.5 }), { chip: "2.5 % reflected", text: "Reflected 2.5 % — retune by hand.", tone: "warn" });
});

test("retuneNs: ≥ 0.5 % from the last retune, RF on only, reference reset at each RF-on edge", () => {
  const buf = [
    smp(0, { tune: 20, load: 10 }),
    smp(1, { tune: 20.3 }), // drift so far 0.3
    smp(2, { tune: 20.6 }), // 0.6 from 20 -> retune
    smp(3, { tune: 20.9 }), // 0.3 from 20.6 -> no
    smp(4, { rf: false, tune: 25 }), // hand-tuning with RF off is not a retune
    smp(5, { rf: true, tune: 25 }), // RF-on edge resets the reference to 25
    smp(6, { tune: 25.2, load: 10.6 }), // load moved 0.6 -> retune
    smp(7, { tune: null, load: null }), // unknown readings never fire
  ];
  assert.deepEqual(retuneNs(buf), [2 * S, 6 * S]);
});

test("toggleWatch: adds/removes, never the control ROI, at most 4", () => {
  assert.deepEqual(toggleWatch(["a"], "b", true, "ctl"), ["a", "b"]);
  assert.deepEqual(toggleWatch(["a", "b"], "a", false, "ctl"), ["b"]);
  assert.deepEqual(toggleWatch(["a"], "ctl", true, "ctl"), ["a"]);
  assert.deepEqual(toggleWatch(["a", "b", "c", "d"], "e", true, null), ["a", "b", "c", "d"]);
  assert.deepEqual(toggleWatch(["a"], "a", true, null), ["a"]);
  assert.deepEqual(WATCH_DEFAULTS, { tempC: 45, ratePerMin: 3, provisional: true });
});

const sh = (o: Partial<Shadow> = {}): Shadow => ({
  valid: true, why: null, k_c_per_w: 0.5, tau_s: 150, confidence: 0.7, t_amb_c: 22, updates: 40,
  suggest_w: 60, plateau_c: 70, settle_s: 200, ttt_s: 125, show: true, ...o,
});

test("tttText: time to target only in to-temperature mode; unreachable and unknown are named", () => {
  assert.equal(tttText("ladder", sh(), 55), "Set in To-temperature mode.");
  assert.equal(tttText("target", undefined, 55), "No estimate yet.");
  assert.equal(tttText("target", sh({ valid: false }), 55), "No estimate yet.");
  assert.equal(tttText("target", sh(), 55), "≈ 2:05 to target at your power");
  assert.equal(tttText("target", sh({ ttt_s: null, plateau_c: 48.4 }), 55), "Won't reach it at your power (levels off ≈ 48 °C).");
  assert.equal(tttText("target", sh({ ttt_s: null, plateau_c: null }), 55), "Waiting for part temperature.");
  assert.equal(tttText("target", sh({ ttt_s: null, plateau_c: 70 }), 55), "Time to target unknown.");
  assert.equal(tttText("target", sh({ ttt_s: null, plateau_c: 48 }), Number.NaN), "Time to target unknown.");
});
