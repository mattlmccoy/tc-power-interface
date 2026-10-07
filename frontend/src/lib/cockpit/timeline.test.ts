import assert from "node:assert/strict";
import { test } from "node:test";

import { showLevelsOffLine, tempRange, tickStep, timeWindow } from "./timeline.ts";

test("live window: last 15 min, or the whole buffer", () => {
  assert.deepEqual(timeWindow(1200, "15", 0), [300, 1200]);
  assert.deepEqual(timeWindow(400, "15", 0), [0, 400]);
  assert.deepEqual(timeWindow(1200, "all", 50), [50, 1200]);
});

test("an unknown time (NaN now or first) has no window, rather than a NaN one", () => {
  assert.equal(timeWindow(Number.NaN, "15", 0), null);
  assert.equal(timeWindow(1200, "all", Number.NaN), null);
  assert.equal(timeWindow(Number.POSITIVE_INFINITY, "15", 0), null);
});

test("ticks at least 56 px apart (phone-width fix from mockup v3)", () => {
  assert.equal(tickStep(900, 1300), 60);
  assert.equal(tickStep(900, 300), 300);
  // the plan's old expectation was 1200 s, which is only ~10 px apart at span 36000 / width 300
  assert.equal(tickStep(36000, 300), 7200);
});

test("tick spacing is at least minPx for any span and width (property)", () => {
  const spans = [1, 59, 60, 300, 900, 3600, 14400, 36000, 100000, 1e6];
  const widths = [20, 100, 300, 375, 1300, 4000];
  for (const span of spans) {
    for (const width of widths) {
      const k = tickStep(span, width);
      assert.ok(k != null && k % 60 === 0, `step for ${span}/${width}`);
      const px = (k / Math.max(span, 60)) * width;
      assert.ok(px >= 56 - 1e-9, `${span} s over ${width} px with ${k} s ticks is only ${px} px`);
    }
  }
});

test("tickStep with an unusable span or width has no ticks instead of throwing or guessing", () => {
  assert.equal(tickStep(900, 0), null);
  assert.equal(tickStep(900, -5), null);
  assert.equal(tickStep(900, Number.NaN), null);
  assert.equal(tickStep(Number.NaN, 300), null);
  assert.equal(tickStep(-1, 300), null);
  assert.equal(tickStep(Number.POSITIVE_INFINITY, 300), null);
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
  assert.equal(showLevelsOffLine("fixed", { show: true, plateau_c: 60 }), true);
});

test("the levels-off line needs a known run mode and a finite plateau", () => {
  assert.equal(showLevelsOffLine("", { show: true, plateau_c: 60 }), false);
  assert.equal(showLevelsOffLine("something-new", { show: true, plateau_c: 60 }), false);
  assert.equal(showLevelsOffLine("ladder", { show: true, plateau_c: null }), false);
  assert.equal(showLevelsOffLine("ladder", { show: true, plateau_c: Number.NaN }), false);
});
