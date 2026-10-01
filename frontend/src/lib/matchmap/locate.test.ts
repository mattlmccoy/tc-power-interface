import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitMap, predictGammaMag, solveMatch, gammaOfZ, type MapPoint } from "./fit.ts";
import { locateMatch, guide, CELL } from "./locate.ts";
import type { Reading } from "./track.ts";
import { DEFAULT_TUNE_OFFSETS, DEFAULT_LOAD_OFFSETS } from "./plan.ts";

// The REAL 09-03 map (old network): Tune and Load move Z 37 deg apart, so readings can separate them.
const { points } = JSON.parse(readFileSync(new URL("./fixtures/fullcap_0903.json", import.meta.url), "utf8"));
const fit = fitMap(points.filter((p: { set: string }) => p.set !== "COOR").map((p: MapPoint) => ({ tune: p.tune, load: p.load, g: p.g })));
const cold = solveMatch(fit);

// The live match moved by `shift` (the hot load). A reading at position P sees the cold map at P - shift.
const shift = { tune: 0.3, load: -0.6 }; // beyond the hold deadbands (0.15 % Tune, 0.5 % Load)
const live = { tune: cold.tune + shift.tune, load: cold.load + shift.load };
const at = (tune: number, load: number, t = 0): Reading => {
  const g = predictGammaMag(fit, tune - shift.tune, load - shift.load);
  return { tune, load, fwd: 100, rev: 100 * g * g, g, gLo: Math.max(0, g - 0.003), gHi: g + 0.003, tFirst: t, tLast: t };
};
const cellAt = (res: ReturnType<typeof locateMatch>, tune: number, load: number) => {
  const i = res.grid.tune.reduce((b, v, k) => (Math.abs(v - tune) < Math.abs(res.grid.tune[b] - tune) ? k : b), 0);
  const j = res.grid.load.reduce((b, v, k) => (Math.abs(v - load) < Math.abs(res.grid.load[b] - load) ? k : b), 0);
  return res.cells[i * res.grid.load.length + j];
};

test("no readings: nothing to say", () => {
  const res = locateMatch(fit, cold, []);
  assert.equal(res.status, "none");
  assert.equal(res.estimate, null);
});

test("one reading is a ring: the true live match is among the candidates, but the direction is ambiguous", () => {
  const res = locateMatch(fit, cold, [at(cold.tune, cold.load)]);
  assert.equal(res.status, "ring");
  assert.equal(cellAt(res, live.tune, live.load), CELL.consistent);
});

// A capture-sized map (the default capture grid from plan.ts). Tune sensitivity is REAL: on 218-2core_v2
// (vna-log-1790803857968) Tune 28.2 → 29.4 % moved Z from 52.0+0.9j to 32.7−4.1j = (−16.1 − 4.2j) Ohm per %.
// No network has a measured Load sensitivity yet, so Load uses the 09-03 ratio: 0.26x Tune, 37 deg apart.
const dZdT = { re: -16.1, im: -4.2 };
const rot = (z: { re: number; im: number }, deg: number, k: number) => {
  const a = (deg * Math.PI) / 180;
  return { re: k * (z.re * Math.cos(a) - z.im * Math.sin(a)), im: k * (z.re * Math.sin(a) + z.im * Math.cos(a)) };
};
const dZdL = rot(dZdT, 37, 0.26);
const C = { tune: 28.6, load: 23.6 };
const zCap = (T: number, L: number) => ({
  re: 50 + dZdT.re * (T - C.tune) + dZdL.re * (L - C.load),
  im: dZdT.im * (T - C.tune) + dZdL.im * (L - C.load),
});
const capFit = fitMap(DEFAULT_TUNE_OFFSETS.flatMap((dt) => DEFAULT_LOAD_OFFSETS.map((dl) => {
  const T = C.tune + dt, L = C.load + dl; // readback lands fractional; the map is in readback coordinates
  return { tune: T, load: L, g: gammaOfZ(zCap(T, L)) };
})));
const capCold = solveMatch(capFit);
const capShift = { tune: 0.6, load: -1.5 }; // a drift big enough to matter (several W reflected at 100 W)
const capLive = { tune: capCold.tune + capShift.tune, load: capCold.load + capShift.load };
const capAt = (tune: number, load: number): Reading => {
  const g = predictGammaMag(capFit, tune - capShift.tune, load - capShift.load);
  const rev = Math.round(100 * g * g * 10) / 10; // the generator reports reflected in 0.1 W steps
  return { tune, load, fwd: 100, rev, g: Math.sqrt(rev / 100), gLo: Math.sqrt(Math.max(0, rev - 0.05) / 100), gHi: Math.sqrt((rev + 0.05) / 100), tFirst: 0, tLast: 0 };
};

const capRun = (moves: number[][], from = capCold) =>
  locateMatch(capFit, capCold, moves.map(([dt, dl]) => capAt(from.tune + dt, from.load + dl)));

test("a Load move then a Tune move pin the drifted match down well enough to act on", () => {
  const res = capRun([[0, 0], [0, -2], [1, -2]]);
  assert.equal(res.status, "spot");
  assert.equal(res.edge, false);
  assert.ok(res.worstGamma <= 0.1, `worst ${res.worstGamma}`);
  assert.ok(res.estimate);
  assert.ok(Math.abs(res.estimate.tune - capLive.tune) <= 0.15, `tune ${res.estimate.tune} vs ${capLive.tune}`);
  assert.ok(Math.abs(res.estimate.load - capLive.load) <= 0.6, `load ${res.estimate.load} vs ${capLive.load}`);
  const g = guide(res, { tune: capCold.tune + 1, load: capCold.load - 2 }); // operator is at the last reading
  assert.equal(g.tune.dir, "down");
  assert.equal(g.load.dir, "up");
});

// The promise behind "spot": moving to the estimate leaves at most worstGamma, whichever candidate is the truth.
const truthAfterMove = (res: ReturnType<typeof locateMatch>) =>
  predictGammaMag(capFit, capCold.tune + res.estimate!.tune - capLive.tune, capCold.load + res.estimate!.load - capLive.load);

test("every spot keeps its worst-case promise for the true drifted match, rough or not", () => {
  for (const moves of [[[0, 0], [0, -2], [1, -2]], [[0, 0], [1, -2]], [[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0]]]) {
    const res = capRun(moves);
    if (res.status !== "spot") continue;
    assert.ok(truthAfterMove(res) <= res.worstGamma + 1e-9, `${JSON.stringify(moves)}: ${truthAfterMove(res)} > ${res.worstGamma}`);
  }
  assert.equal(capRun([[0, 0], [1, 0]]).status, "spot"); // a single Tune bump is already usable here (rough)
});

test("when candidates run into the uncalibrated area the result says so and is never a spot", () => {
  const res = capRun([[0, 0], [-1, 0], [0, 2]]); // Tune -1 asks the map about positions beyond its range
  assert.equal(res.edge, true);
  assert.notEqual(res.status, "spot");
});

test("readings that no single shift of the map can explain are reported as not fitting", () => {
  const a = at(cold.tune, cold.load);
  const contradiction: Reading = { ...a, g: 0.6, gLo: 0.6, gHi: 0.61, rev: 36 };
  const res = locateMatch(fit, cold, [a, contradiction]);
  assert.equal(res.status, "nofit");
  assert.equal(res.estimate, null);
});

test("matched where the operator stands: guidance says hold", () => {
  const P = { tune: capLive.tune, load: capLive.load };
  const res = capRun([[0, 0], [0, -2], [1, -2]], P);
  assert.equal(res.status, "spot");
  const g = guide(res, P);
  assert.equal(g.tune.dir, "hold");
  assert.equal(g.load.dir, "hold");
});
