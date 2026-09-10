import test from "node:test";
import assert from "node:assert/strict";
import { dipOf, shapeTune, costAt, F0 } from "./autotune_shape.ts";
import { modelSweep, DEFAULT_NETWORK } from "./network_model.ts";

// The control law is validated end-to-end OFFLINE against the 496 real bench sweeps (2026-09-09 logs):
// 9/9 detunes recover to RL < −24 dB. These unit tests exercise the same law on the frequency-resolved
// synthetic network model (calibrated to the bench signs: dip slides with tune, R with load).
const { tStar, lStar } = DEFAULT_NETWORK; // 36 / 65
const probe = (t: number, l: number) => modelSweep(t, l);
const cost = (t: number, l: number) => costAt(modelSweep(t, l));

test("dipOf finds the resonance dip on 13.56 at the match", () => {
  const d = dipOf(modelSweep(tStar, lStar))!;
  assert.ok(Math.abs(d.freqHz - F0) < 3e4, `dip ${d.freqHz}`);
  assert.ok(d.gammaMin < 0.02);
});

test("dip frequency moves monotonically with tune (the PHASE-A control signal)", () => {
  const dLow = dipOf(modelSweep(tStar - 2, lStar))!.freqHz;
  const dHigh = dipOf(modelSweep(tStar + 2, lStar))!.freqHz;
  assert.ok(dHigh < dLow, "more tune -> lower dip frequency");
});

test("does NOT wander off a converged match (leaves a good match alone)", async () => {
  let n = 0;
  const r = await shapeTune((t, l) => { n++; return modelSweep(t, l); }, { tune: tStar, load: lStar }, {});
  assert.equal(r.converged, true);
  assert.equal(r.tune, tStar); assert.equal(r.load, lStar);
  assert.ok(n <= 2, `should stop at once at a match, took ${n}`);
});

test("recovers a combined T+L detune (Matt's case): dip locks tune, load scan finds the match", async () => {
  const r = await shapeTune(probe, { tune: tStar + 2, load: lStar - 4 }, {});
  assert.equal(r.converged, true, `caps ${r.tune}/${r.load}`);
  assert.ok(Math.abs(r.tune - tStar) <= 1, `tune ${r.tune}`);
  assert.ok(Math.abs(r.load - lStar) <= 1, `load ${r.load}`);
});

test("recovers a tune-only detune via the dip-frequency signal", async () => {
  const r = await shapeTune(probe, { tune: tStar + 2, load: lStar }, {});
  assert.equal(r.converged, true, `caps ${r.tune}/${r.load}`);
});

test("recovers a load-only detune by scanning load at the locked tune", async () => {
  const r = await shapeTune(probe, { tune: tStar, load: lStar - 5 }, {});
  assert.equal(r.converged, true, `caps ${r.tune}/${r.load}`);
  assert.ok(Math.abs(r.load - lStar) <= 1, `load ${r.load}`);
});

test("monotonic: never ends worse than it started (best-so-far + restore)", async () => {
  const start = { tune: tStar + 3, load: lStar - 6 };
  const c0 = cost(start.tune, start.load);
  const r = await shapeTune(probe, start, {});
  assert.ok(cost(r.tune, r.load) <= c0 + 1e-9);
});

test("shouldStop halts the loop", async () => {
  let n = 0;
  const r = await shapeTune(probe, { tune: 20, load: 40 }, { shouldStop: () => ++n > 4 });
  assert.equal(r.converged, false);
});
