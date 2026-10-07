import assert from "node:assert/strict";
import { test } from "node:test";

import { coreLevel, ladderStep, nextPlateau, parseLadder } from "./ladder.ts";

test("parseLadder: numbers from free text, positive, unique, sorted; the rest is reported", () => {
  assert.deepEqual(parseLadder("10, 5 20;20 x -3"), { steps: [5, 10, 20], rejected: ["x", "-3"] });
  assert.deepEqual(parseLadder(""), { steps: [], rejected: [] });
});

test("parseLadder keeps decimals; .5 is 0.5; a comma is a separator, so 1,5 is two steps", () => {
  assert.deepEqual(parseLadder("7.5, 10").steps, [7.5, 10]);
  assert.deepEqual(parseLadder(".5").steps, [0.5]);
  assert.deepEqual(parseLadder("0.5").steps, [0.5]);
  assert.deepEqual(parseLadder("1,5").steps, [1, 5]);
});

test("parseLadder rejects malformed tokens whole instead of salvaging digits from them", () => {
  assert.deepEqual(parseLadder("1.5.5"), { steps: [], rejected: ["1.5.5"] });
  assert.deepEqual(parseLadder("1e3"), { steps: [], rejected: ["1e3"] });
  assert.deepEqual(parseLadder("5-3"), { steps: [], rejected: ["5-3"] });
  assert.deepEqual(parseLadder("10 .. 0"), { steps: [10], rejected: ["..", "0"] });
});

test("ladderStep: the step you're on (1-based) and the next one", () => {
  assert.deepEqual(ladderStep([5, 10, 20], 10.4), { index: 2, next: 20 });
  assert.deepEqual(ladderStep([5, 10, 20], 0), { index: 0, next: 5 });
  assert.deepEqual(ladderStep([5, 10, 20], 20.5), { index: 3, next: null });
  assert.deepEqual(ladderStep([], 40), { index: 0, next: null });
});

test("ladderStep tolerance is relative (2 %, at least 0.1 W), not a flat 1 W", () => {
  assert.equal(ladderStep([2, 5], 1.5).index, 0); // 1 W under a 2 W step is NOT on it
  assert.equal(ladderStep([2, 5], 1.95).index, 1);
  assert.equal(ladderStep([100], 98.5).index, 1); // 2 % of 100 W = 2 W
  assert.equal(ladderStep([100], 97).index, 0);
});

test("ladderStep with an unknown forward power is unknown, never step 0", () => {
  assert.deepEqual(ladderStep([5, 10], Number.NaN), { index: null, next: null });
  assert.deepEqual(ladderStep([5, 10], Number.POSITIVE_INFINITY), { index: null, next: null });
});

test("nextPlateau needs a valid estimate and finite inputs", () => {
  assert.equal(nextPlateau({ valid: true, k_c_per_w: 0.5, t_amb_c: 24 }, 70), 59);
  assert.equal(nextPlateau({ valid: false, k_c_per_w: null, t_amb_c: 24 }, 70), null);
  assert.equal(nextPlateau({ valid: true, k_c_per_w: Number.NaN, t_amb_c: 24 }, 70), null);
  assert.equal(nextPlateau({ valid: true, k_c_per_w: 0.5, t_amb_c: 24 }, Number.NaN), null);
});

test("coreLevel: warn on temperature or rate; unknown is never ok", () => {
  const th = { tempC: 45, ratePerMin: 3 };
  assert.equal(coreLevel(31.9, 1.1, th), "ok");
  assert.equal(coreLevel(46, 0.2, th), "warn");
  assert.equal(coreLevel(30, 3.4, th), "warn");
  assert.equal(coreLevel(null, null, th), "unknown");
  assert.equal(coreLevel(Number.NaN, 1, th), "unknown");
});

test("coreLevel: a missing rate (first 60 s, invalid sample) is unknown, not ok", () => {
  const th = { tempC: 45, ratePerMin: 3 };
  assert.equal(coreLevel(30, null, th), "unknown");
  assert.equal(coreLevel(30, Number.NaN, th), "unknown");
  assert.equal(coreLevel(46, null, th), "warn"); // over temperature warns whatever the rate
  assert.equal(coreLevel(46, Number.NaN, th), "warn");
});

test("coreLevel: non-finite thresholds are unknown", () => {
  assert.equal(coreLevel(30, 1, { tempC: Number.NaN, ratePerMin: 3 }), "unknown");
  assert.equal(coreLevel(30, 1, { tempC: 45, ratePerMin: Number.NaN }), "unknown");
});
