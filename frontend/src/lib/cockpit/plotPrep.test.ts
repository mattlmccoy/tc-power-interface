import assert from "node:assert/strict";
import { test } from "node:test";

import { gapSegments, minMaxIndices, plateauForAxis } from "./plotPrep.ts";

test("gapSegments: split where consecutive samples are more than maxGap apart", () => {
  assert.deepEqual(gapSegments([0, 1, 2, 9, 10, 20], 5), [[0, 3], [3, 5], [5, 6]]);
  assert.deepEqual(gapSegments([0, 0.5, 1], 5), [[0, 3]]);
  assert.deepEqual(gapSegments([], 5), []);
  assert.deepEqual(gapSegments([0, 5, 10], 5), [[0, 3]]); // exactly maxGap is not a gap
});

test("minMaxIndices: all indices when sparse; per-pixel min and max (in order) when dense", () => {
  const ts = [0, 1, 2, 3];
  assert.deepEqual(minMaxIndices(ts, [1, 2, 3, 4], 0, 4, 0, 4, 10), [0, 1, 2, 3]); // 4 points ≤ 2 × 10 buckets
  // 12 points over 2 buckets (6 each): bucket 0 = idx 0-5, bucket 1 = idx 6-11
  const t12 = Array.from({ length: 12 }, (_, i) => i);
  const v12 = [5, 9, 1, 5, 5, 5, 3, 3, 0, 3, 8, 3];
  assert.deepEqual(minMaxIndices(t12, v12, 0, 12, 0, 12, 2), [1, 2, 8, 10]);
});

test("minMaxIndices: a null inside a dense bucket is kept, so the line still breaks there", () => {
  const t12 = Array.from({ length: 12 }, (_, i) => i);
  const v12 = [5, 9, null, 1, 5, 5, 3, 3, 0, 3, 8, 3];
  assert.deepEqual(minMaxIndices(t12, v12, 0, 12, 0, 12, 2), [1, 2, 3, 8, 10]);
  const allNull = [null, null, null, null, null, null];
  assert.deepEqual(minMaxIndices(t12.slice(0, 6), allNull, 0, 6, 0, 6, 1), [0]);
});

test("plateauForAxis: a levels-off value more than 100 °C from the part (or target) is not plotted", () => {
  assert.equal(plateauForAxis(60, 52, 55), 60);
  assert.equal(plateauForAxis(900, 52, 55), null); // a bad fit must not squash the lane
  assert.equal(plateauForAxis(140, null, 55), 140); // part unknown: judged against the target
  assert.equal(plateauForAxis(400, null, 55), null);
  assert.equal(plateauForAxis(60, null, null), null); // nothing to judge it against
  assert.equal(plateauForAxis(null, 52, 55), null);
});
