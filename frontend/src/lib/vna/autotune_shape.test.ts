import test from "node:test";
import assert from "node:assert/strict";
import { dipOf, shapeTune } from "./autotune_shape.ts";
import { modelSweep, DEFAULT_NETWORK } from "./network_model.ts";
import { magnitude, nearestPointByFrequency, type SweepPoint } from "./rf.ts";

const F0 = 13.56e6;
const WIN = { start: 13.06e6, stop: 14.06e6, points: 201 }; // the shipped fine window (5 kHz/pt)
const g1356 = (s: SweepPoint[]) => magnitude(nearestPointByFrequency(s, F0)!.s11);

test("dipOf finds the frequency + depth of the min-|Γ| point", () => {
  const d = dipOf(modelSweep(DEFAULT_NETWORK.tStar, DEFAULT_NETWORK.lStar, WIN))!;
  assert.ok(Math.abs(d.freqHz - F0) < 6000, `dip at ${d.freqHz}`);
  assert.ok(d.gammaMin < 0.02, `depth ${d.gammaMin}`);
});

test("REGRESSION (fast): from the match, +3% tune → recovers in few sweeps", async () => {
  let sweeps = 0;
  const probe = (t: number, l: number) => { sweeps++; return modelSweep(t, l, WIN); };
  const r = await shapeTune(probe, { tune: DEFAULT_NETWORK.tStar + 3, load: DEFAULT_NETWORK.lStar }, {});
  assert.equal(r.converged, true, `caps ${r.tune},${r.load} after ${sweeps} sweeps`);
  assert.ok(sweeps < 40, `too many sweeps: ${sweeps}`);
  assert.ok(g1356(modelSweep(r.tune, r.load, WIN)) < 0.1);
});

test("does NOT wander off a converged match (the bench bug)", async () => {
  let sweeps = 0;
  const r = await shapeTune((t, l) => { sweeps++; return modelSweep(t, l, WIN); },
    { tune: DEFAULT_NETWORK.tStar, load: DEFAULT_NETWORK.lStar }, {});
  assert.equal(r.converged, true);
  assert.equal(r.tune, DEFAULT_NETWORK.tStar);
  assert.equal(r.load, DEFAULT_NETWORK.lStar);
  assert.ok(sweeps <= 2, `should stop immediately at a match, took ${sweeps} sweeps`);
});

test("monotonic: never ends worse than it started", async () => {
  const start = { tune: DEFAULT_NETWORK.tStar + 5, load: DEFAULT_NETWORK.lStar - 4 };
  const c0 = g1356(modelSweep(start.tune, start.load, WIN));
  const r = await shapeTune((t, l) => modelSweep(t, l, WIN), start, {});
  assert.ok(g1356(modelSweep(r.tune, r.load, WIN)) <= c0);
});

test("recovers a diagonal (both caps off) detune", async () => {
  const r = await shapeTune((t, l) => modelSweep(t, l, WIN), { tune: DEFAULT_NETWORK.tStar - 4, load: DEFAULT_NETWORK.lStar + 5 }, {});
  assert.equal(r.converged, true, `caps ${r.tune},${r.load}`);
});

test("shouldStop halts the loop", async () => {
  let n = 0;
  const r = await shapeTune((t, l) => modelSweep(t, l, WIN), { tune: 30, load: 30 }, { shouldStop: () => ++n > 3 });
  assert.equal(r.converged, false);
});
