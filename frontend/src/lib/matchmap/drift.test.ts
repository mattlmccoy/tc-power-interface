import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyDrift, driftSample, driftSummary, DRIFT_DEFAULTS } from "./drift.ts";
import type { TelSample } from "./track.ts";

const samples: TelSample[] = JSON.parse(readFileSync(new URL("./fixtures/fullsweep_1002.json", import.meta.url), "utf8")).samples;
const replay = (untilMs = Infinity) => {
  let st = emptyDrift();
  for (const s of samples) { if (s.tMs > untilMs) break; st = driftSample(st, s); }
  return st;
};

test("REAL full sweep: delivered energy matches the trapezoid of forward power while RF is on (~8.2 Wh)", () => {
  const st = replay();
  assert.ok(st.eWh > 7.8 && st.eWh < 8.6, `eWh ${st.eWh}`);
});

test("REAL full sweep: matched positions are recorded in order — T19.8 early, down to T14.8 at the end", () => {
  const st = replay();
  const tunes = st.holds.map((h) => h.tune);
  assert.equal(tunes[0], 19.8);
  assert.equal(tunes[tunes.length - 1], 14.8);
  // positions are the readback at the start of each hold, so ±0.1 % flicker shows (16.9 for 16.8)
  for (const t of [17.8, 16.8, 15.8]) assert.ok(tunes.some((x) => Math.abs(x - t) <= 0.15), `missing matched hold at T${t}: ${tunes}`);
  assert.ok(!tunes.includes(12.8), "the T12.8 overshoot (1.8 W reflected) is not a matched hold");
});

// Matched holds in that run (Wh at the match → Tune/Load): 1.9→19.8, 2.5→17.8, 3.5→16.9, 4.9→15.9,
// 6.2→14.8 (L8.6), then Tune stopped and Load took up the change: 7.6→14.8/L7.5.
test("REAL full sweep: flat for the first ~2 Wh, ≈ −0.8 %/Wh Tune mid-run, then Load takes over at the end", () => {
  const early = driftSummary(replay(300_000), { tune: 19.8, load: 10.7, fwd: 30 });
  assert.ok(early.tuneRate === null || Math.abs(early.tuneRate) < 0.3, `early rate ${early.tuneRate}`);
  const mid = driftSummary(replay(700_000), { tune: 14.8, load: 8.6, fwd: 70 });
  assert.ok(mid.tuneRate !== null && mid.tuneRate < -0.6 && mid.tuneRate > -1.2, `mid tune rate ${mid.tuneRate}`);
  const end = driftSummary(replay(), { tune: 14.8, load: 7.5, fwd: 70 });
  assert.ok(end.tuneRate !== null && end.tuneRate < -0.2 && end.tuneRate > -1.0, `end tune rate ${end.tuneRate}`);
  assert.ok(end.loadRate !== null && end.loadRate < 0, `end load rate ${end.loadRate}`);
  assert.equal(end.tuneLeft, 14.8);
  assert.equal(end.loadLeft, 7.5);
  assert.ok(end.whToTuneFloor !== null && end.whToTuneFloor > 8 && end.whToTuneFloor < 45, `Wh to Tune floor ${end.whToTuneFloor}`);
  assert.ok(end.minToTuneFloor !== null && Math.abs(end.minToTuneFloor - (end.whToTuneFloor! * 60) / 70) < 1e-9);
  assert.ok(end.whToLoadFloor !== null && end.whToLoadFloor > 0, `Wh to Load floor ${end.whToLoadFloor}`);
});

const s = (tMs: number, over: Partial<TelSample> = {}): TelSample => ({ tMs, rfOn: true, fwd: 50, rev: 0, tune: 30, load: 40, ...over });

test("a position only counts as a matched hold when held ≥ 3 s with reflected ≤ 1 %", () => {
  let st = emptyDrift();
  for (const t of [0, 1000, 2000]) st = driftSample(st, s(t));
  assert.equal(st.holds.length, 0);
  st = driftSample(st, s(3000));
  assert.equal(st.holds.length, 1);
  let bad = emptyDrift();
  for (const t of [0, 1000, 2000, 3000, 4000]) bad = driftSample(bad, s(t, { rev: 1 })); // 2 % reflected
  assert.equal(bad.holds.length, 0);
});

test("RF off long enough to cool resets the heating history", () => {
  let st = emptyDrift();
  for (const t of [0, 1000, 2000, 3000]) st = driftSample(st, s(t));
  assert.ok(st.eWh > 0);
  st = driftSample(st, s(4000, { rfOn: false, fwd: 0 }));
  st = driftSample(st, s(4000 + DRIFT_DEFAULTS.resetOffMs + 1, { rfOn: false, fwd: 0 }));
  assert.equal(st.eWh, 0);
  assert.equal(st.holds.length, 0);
});

test("travel warning: err near the rail or within 5 min of it, warn within 8 % or 15 min, else ok", async () => {
  const { travelLevel } = await import("./drift.ts");
  const base = { eWh: 5, holds: 4, tuneRate: -0.8, loadRate: null, tuneLeft: 20, loadLeft: 30, whToTuneFloor: 25, minToTuneFloor: 30, whToLoadFloor: null, minToLoadFloor: null };
  assert.equal(travelLevel(base), "ok");
  assert.equal(travelLevel({ ...base, tuneLeft: 7.5 }), "warn");
  assert.equal(travelLevel({ ...base, minToTuneFloor: 12 }), "warn");
  assert.equal(travelLevel({ ...base, loadLeft: 2.5 }), "err");
  assert.equal(travelLevel({ ...base, minToLoadFloor: 4 }), "err");
  assert.equal(travelLevel({ ...base, tuneLeft: null, loadLeft: null, minToTuneFloor: null }), "ok");
});
