import test from "node:test";
import assert from "node:assert/strict";
import { dipOf, shapeTune, costAt } from "./autotune_shape.ts";
import { modelSweep, DEFAULT_NETWORK } from "./network_model.ts";

const { tStar, lStar } = DEFAULT_NETWORK; // 36 / 65
const cost = (t: number, l: number) => costAt(modelSweep(t, l));
const probe = (t: number, l: number) => modelSweep(t, l);

test("dipOf finds the min-|Γ| point near resonance", () => {
  const d = dipOf(modelSweep(tStar, lStar))!;
  assert.ok(Math.abs(d.freqHz - 13.56e6) < 30000);
  assert.ok(d.gammaMin < 0.02);
});

test("does NOT wander off a converged match (the bench bug)", async () => {
  let sweeps = 0;
  const r = await shapeTune((t, l) => { sweeps++; return modelSweep(t, l); }, { tune: tStar, load: lStar }, {});
  assert.equal(r.converged, true);
  assert.equal(r.tune, tStar);
  assert.equal(r.load, lStar);
  assert.ok(sweeps <= 2, `should stop at once at a match, took ${sweeps}`);
});

test("load-only detune (Matt's case): recovers by moving LOAD back, converges", async () => {
  // start at the match, then load pulled down (pure R detune): R climbs, still on-frequency
  const start = { tune: tStar, load: lStar - 4 };
  const r = await shapeTune(probe, start, {});
  assert.equal(r.converged, true, `caps ${r.tune},${r.load}`);
  assert.ok(r.load > start.load, `should raise load back toward the match (got ${r.load})`);
  assert.ok(Math.abs(r.tune - tStar) <= 1, `should not have wandered tune (got ${r.tune})`);
});

test("tune detune recovers", async () => {
  const r = await shapeTune(probe, { tune: tStar + 2, load: lStar }, {});
  assert.equal(r.converged, true, `caps ${r.tune},${r.load}`);
});

test("monotonic: never ends worse than it started", async () => {
  const start = { tune: tStar + 3, load: lStar - 3 };
  const c0 = cost(start.tune, start.load);
  const r = await shapeTune(probe, start, {});
  assert.ok(cost(r.tune, r.load) <= c0 + 1e-9);
});

test("shouldStop halts the loop", async () => {
  let n = 0;
  const r = await shapeTune(probe, { tune: 20, load: 40 }, { shouldStop: () => ++n > 4 });
  assert.equal(r.converged, false);
});
