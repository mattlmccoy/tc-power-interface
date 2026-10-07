import assert from "node:assert/strict";
import { test } from "node:test";

import { coreLevel, ladderStep, nextPlateau, parseLadder } from "./ladder.ts";

test("parseLadder: numbers from free text, positive, unique, sorted", () => {
  assert.deepEqual(parseLadder("10, 5 20;20 x -3"), [5, 10, 20]);
  assert.deepEqual(parseLadder(""), []);
});

test("parseLadder keeps decimals and survives garbage like 1.5.5", () => {
  assert.deepEqual(parseLadder("7.5, 10"), [7.5, 10]);
  const g = parseLadder("1.5.5 abc ..");
  assert.ok(g.every((x) => Number.isFinite(x) && x > 0));
});

test("ladderStep: the step you're on (1-based) and the next one", () => {
  assert.deepEqual(ladderStep([5, 10, 20], 10.4), { index: 2, next: 20 });
  assert.deepEqual(ladderStep([5, 10, 20], 0), { index: 0, next: 5 });
  assert.deepEqual(ladderStep([5, 10, 20], 20.5), { index: 3, next: null });
  assert.deepEqual(ladderStep([], 40), { index: 0, next: null });
});

test("nextPlateau needs a valid estimate", () => {
  assert.equal(nextPlateau({ valid: true, k_c_per_w: 0.5, t_amb_c: 24 }, 70), 59);
  assert.equal(nextPlateau({ valid: false, k_c_per_w: null, t_amb_c: 24 }, 70), null);
});

test("coreLevel: warn on temperature or rate; unknown is never ok", () => {
  const th = { tempC: 45, ratePerMin: 3 };
  assert.equal(coreLevel(31.9, 1.1, th), "ok");
  assert.equal(coreLevel(46, 0.2, th), "warn");
  assert.equal(coreLevel(30, 3.4, th), "warn");
  assert.equal(coreLevel(null, null, th), "unknown");
  assert.equal(coreLevel(30, null, th), "ok");
  assert.equal(coreLevel(Number.NaN, 1, th), "unknown");
});
