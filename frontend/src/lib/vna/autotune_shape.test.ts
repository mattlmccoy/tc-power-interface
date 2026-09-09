import test from "node:test";
import assert from "node:assert/strict";
import { dipOf, shapeTune, costAt } from "./autotune_shape.ts";
import { modelSweep, DEFAULT_NETWORK } from "./network_model.ts";
import type { SweepPoint } from "./rf.ts";

const { tStar, lStar } = DEFAULT_NETWORK; // 36 / 65
const cost = (t: number, l: number) => costAt(modelSweep(t, l));
const probe = (t: number, l: number) => modelSweep(t, l);

// ── REAL captured surface (data-contract-verification: fixtures from reality, not invented) ──
// Every cell is a min-|Γ| readback from the 2026-09-09 bench logs (new_auto-match-mode + manual_again).
// The point: at tune 36, scanning LOAD has TWO minima — a shallow one at load ~59 (|Γ|0.125, where the
// old monotonic tuner quit at RL −18) and the DEEP match at load ~65 (|Γ|0.021, RL −33, which Matt hit
// by hand) — separated by a RIDGE at load ~62 (|Γ|0.24). A greedy ±1 descent is trapped at 59; a full
// line-search crosses the ridge to 65. tune 35/37 are catastrophic (dip thrown off 13.56).
const REAL: ReadonlyArray<readonly [number, number, number, number]> = [ // [tune, load, R, X]
  [36, 65.5, 48.3, -1.2], [36, 64.5, 54.5, -3.0], [36, 63.5, 62.4, -4.3], [36, 59.5, 43.8, -10.0],
  [36, 58.5, 49.7, -13.0], [36, 60.5, 38.8, -6.9], [36, 62.5, 30.6, -0.8], [37, 58.5, 12.0, 12.4],
  [35, 60.5, 66.5, 101.0], [37, 59.5, 11.0, 14.7], [37, 60.5, 10.6, 16.2], [35, 59.5, 57.2, 102.9],
  [35, 58.5, 57.2, 104.3], [35, 57.5, 52.6, 104.8],
];
function s11FromZ(R: number, X: number) {
  const D = (R + 50) ** 2 + X ** 2;
  return { re: ((R - 50) * (R + 50) + X * X) / D, im: (X * 100) / D };
}
/** Nearest captured cell (tune weighted equally) → a single-point sweep carrying its measured Z@13.56. */
function realProbe(tune: number, load: number): SweepPoint[] {
  let best = REAL[0], bd = Infinity;
  for (const c of REAL) { const d = (c[0] - tune) ** 2 + (c[1] - load) ** 2; if (d < bd) { bd = d; best = c; } }
  return [{ frequency: 13.56e6, s11: s11FromZ(best[2], best[3]), s21: { re: 0, im: 0 } }];
}
const realCost = (t: number, l: number) => costAt(realProbe(t, l));

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

test("escapes the local min to the DEEP match (the bench case Matt beat by hand)", async () => {
  // start exactly where the old monotonic tuner quit: tune 36, load 59 → |Γ|0.125, RL −18.
  assert.ok(Math.abs(realCost(36, 59) - 0.125) < 0.02, "fixture: start is the shallow −18 dB min");
  assert.ok(realCost(36, 62) > 0.2, "fixture: a ridge sits between the two minima");
  assert.ok(realCost(36, 65) < 0.05, "fixture: the deep −33 dB match is at load ~65");
  const r = await shapeTune(realProbe, { tune: 36, load: 59 }, {});
  assert.equal(r.converged, true, `should reach the deep match, got caps ${r.tune}/${r.load}`);
  assert.ok(realCost(r.tune, r.load) <= 0.06, `should be a great match (|Γ|=${realCost(r.tune, r.load).toFixed(3)})`);
  assert.ok(r.load >= 63, `deep well is at high load (got load ${r.load})`);
});

test("fine endgame: single ±1 clicks refine to the EXACT match with no coarse sweep (L fine-tunes in)", async () => {
  // Matt's finish: T already in the zone, LOAD walked one click at a time into the exact spot.
  // maxRounds:0 disables the coarse line search, so ONLY the fine single-click endgame can do this.
  const r = await shapeTune(probe, { tune: tStar, load: lStar - 2 }, { maxRounds: 0 });
  assert.equal(r.converged, true, `caps ${r.tune}/${r.load}`);
  assert.equal(r.tune, tStar);
  assert.equal(r.load, lStar);
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
