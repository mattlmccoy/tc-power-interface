import test from "node:test";
import assert from "node:assert/strict";
import { estimateJacobian, solve2x2, convergedZ, costZ, newtonTune } from "./autotune2d.ts";
import { zAt, DEFAULT_NETWORK } from "./network_model.ts";

test("solve2x2 solves a well-conditioned system and rejects singular", () => {
  assert.deepEqual(solve2x2([[2, 0], [0, 4]], [4, 8]), [2, 2]);
  assert.equal(solve2x2([[1, 2], [2, 4]], [1, 1]), null);
});

test("estimateJacobian finite-differences ∂Z/∂cap", () => {
  const J = estimateJacobian({ re: 10, im: 20 }, { re: 12, im: 21 }, { re: 10.5, im: 24 }, 1, 2);
  assert.equal(J[0][0], 2); // dR/dT
  assert.equal(J[1][0], 1); // dX/dT
  assert.equal(J[0][1], 0.25); // dR/dL
  assert.equal(J[1][1], 2); // dX/dL
});

test("convergedZ: 50+j0 passes, a poor Z fails; costZ→0 at match", () => {
  assert.equal(convergedZ({ re: 50, im: 0 }), true);
  assert.equal(convergedZ({ re: 48, im: -82 }), false);
  assert.ok(costZ({ re: 50, im: 0 }) < 1e-6);
});

test("REGRESSION (Matt's case): from the match, +3% tune → 2-D recovers", async () => {
  const r = await newtonTune((t, l) => zAt(t, l), { tune: DEFAULT_NETWORK.tStar + 3, load: DEFAULT_NETWORK.lStar }, {});
  assert.equal(r.converged, true, `not converged: caps=${r.tune},${r.load} iters=${r.iters}`);
  assert.ok(Math.abs(r.tune - DEFAULT_NETWORK.tStar) <= 1 && Math.abs(r.load - DEFAULT_NETWORK.lStar) <= 1,
    `landed at ${r.tune},${r.load}`);
});

test("2-D recovers a diagonal (both caps off) detune", async () => {
  const r = await newtonTune((t, l) => zAt(t, l), { tune: DEFAULT_NETWORK.tStar - 4, load: DEFAULT_NETWORK.lStar + 5 }, {});
  assert.equal(r.converged, true, `not converged: caps=${r.tune},${r.load}`);
});

test("monotonic: never returns a worse match than the start when it stops", async () => {
  const start = { tune: DEFAULT_NETWORK.tStar + 6, load: DEFAULT_NETWORK.lStar - 3 };
  const c0 = costZ(zAt(start.tune, start.load));
  const r = await newtonTune((t, l) => zAt(t, l), start, {});
  assert.ok(costZ(zAt(r.tune, r.load)) <= c0);
});
