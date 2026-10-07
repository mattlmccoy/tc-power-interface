import assert from "node:assert/strict";
import { test } from "node:test";

import { showLevelsOffLine, tempRange, tickStep, timeWindow } from "./timeline.ts";

test("live window: last 15 min, or the whole buffer", () => {
  assert.deepEqual(timeWindow(1200, "15", 0), [300, 1200]);
  assert.deepEqual(timeWindow(400, "15", 0), [0, 400]);
  assert.deepEqual(timeWindow(1200, "all", 50), [50, 1200]);
});

test("ticks at least 56 px apart (phone-width fix from mockup v3)", () => {
  assert.equal(tickStep(900, 1300), 60);
  assert.equal(tickStep(900, 300), 300);
  assert.equal(tickStep(36000, 300), 1200);
});

test("tickStep with a zero-width plot does not throw and returns the widest step", () => {
  assert.equal(tickStep(900, 0), 1200);
});

test("temperature range pads by 2 °C and includes extras; ignores unknowns", () => {
  assert.deepEqual(tempRange([30.4, null, 41.2], [55]), [28, 57]);
  assert.deepEqual(tempRange([null], []), [20, 30]);
});

test("temperature range ignores NaN and Infinity", () => {
  assert.deepEqual(tempRange([30.4, Number.NaN, Number.POSITIVE_INFINITY, 41.2], [Number.NEGATIVE_INFINITY, 55]), [28, 57]);
  assert.deepEqual(tempRange([Number.NaN], [Number.POSITIVE_INFINITY]), [20, 30]);
});

test("temperature range copes with a 4 h buffer (no spread-argument overflow)", () => {
  const big = Array.from({ length: 300000 }, (_, i) => 20 + (i % 40));
  assert.deepEqual(tempRange(big, []), [18, 61]);
});

test("the levels-off line only at ≥ 30 % confidence, and never in to-temperature mode", () => {
  assert.equal(showLevelsOffLine("ladder", { show: true, plateau_c: 60 }), true);
  assert.equal(showLevelsOffLine("ladder", { show: false, plateau_c: 60 }), false);
  assert.equal(showLevelsOffLine("target", { show: true, plateau_c: 60 }), false);
});
