import assert from "node:assert/strict";
import { test } from "node:test";

import { fitRange, polyline, xOf, yOf } from "./heroTrace.ts";

test("fitRange always includes the target even when it is above the data", () => {
  const r = fitRange([100, 150], [160], 185, 0);
  assert.equal(r.lo, 100);
  assert.equal(r.hi, 185);
});

test("fitRange pads and never collapses to a zero-height range", () => {
  const r = fitRange([], [], 185, 0.1);
  assert.ok(r.hi > r.lo);
  const flat = fitRange([50], [], 50, 0);
  assert.ok(flat.hi > flat.lo);
});

test("yOf inverts: hi maps to top (0), lo maps to bottom (height)", () => {
  assert.equal(yOf(200, { lo: 0, hi: 200 }, 100), 0);
  assert.equal(yOf(0, { lo: 0, hi: 200 }, 100), 100);
  assert.equal(yOf(100, { lo: 0, hi: 200 }, 100), 50);
});

test("xOf spreads points evenly across the width", () => {
  assert.equal(xOf(0, 5, 400), 0);
  assert.equal(xOf(4, 5, 400), 400);
  assert.equal(xOf(0, 1, 400), 0); // single/empty series never divides by zero
});

test("polyline emits space-separated x,y pairs", () => {
  assert.equal(polyline([0, 100], { lo: 0, hi: 100 }, 100, 50), "0.0,50.0 100.0,0.0");
});
