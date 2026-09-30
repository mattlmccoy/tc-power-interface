import assert from "node:assert/strict";
import test from "node:test";

import { interpS11At, F0 } from "./autotune_shape.ts";
import { centredSweep, f0GridOffsetHz } from "./sweep.ts";

// 2026-09-30: the live sweep was 11-16 MHz / 401 pts (12.5 kHz), so 13.56 MHz fell BETWEEN grid points
// and was linearly interpolated. On the 218-2core_v2 network that reported a 41.6 dB match as 36.6 dB
// (see experiments/.../2026-09-30_COLD_MATCH_MAP_FEASIBILITY_ANALYSIS.md, section C).

test("centredSweep: 13.56 MHz is EXACTLY the middle grid point, same 5 MHz span / 12.5 kHz step", () => {
  const w = centredSweep(F0, 12.5e3, 401);
  assert.deepEqual(w, { start: 11_060_000, stop: 16_060_000, points: 401 });
  const step = (w.stop - w.start) / (w.points - 1);
  assert.equal(step, 12_500);
  assert.equal(w.start + 200 * step, F0);
});

test("centredSweep: an even point count has no centre point, so it is rejected", () => {
  assert.throws(() => centredSweep(F0, 12.5e3, 400), /odd/);
});

test("f0GridOffsetHz: 0 when a returned point sits at 13.56 MHz; 2.5 kHz on the old 11-16 MHz grid", () => {
  const grid = (start: number, n: number, step: number) =>
    Array.from({ length: n }, (_, i) => ({ frequency: start + i * step, s11: { re: 0, im: 0 } }));
  assert.equal(f0GridOffsetHz(grid(11_060_000, 401, 12_500), F0), 0);
  assert.equal(f0GridOffsetHz(grid(11_000_000, 401, 12_500), F0), 2_500);
  assert.equal(f0GridOffsetHz([], F0), null);
});

test("interpS11At returns the measured sample itself when a grid point is exactly at 13.56 MHz", () => {
  const sweep = [
    { frequency: 13_547_500, s11: { re: 0.2, im: 0.1 }, s21: { re: 0, im: 0 } },
    { frequency: 13_560_000, s11: { re: 0.004, im: -0.007 }, s21: { re: 0, im: 0 } },
    { frequency: 13_572_500, s11: { re: -0.2, im: 0.3 }, s21: { re: 0, im: 0 } },
  ];
  assert.deepEqual(interpS11At(sweep, F0), { re: 0.004, im: -0.007 });
});
