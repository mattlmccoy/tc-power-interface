import assert from "node:assert/strict";
import { test } from "node:test";

import { f1, mmss } from "./format.ts";

test("mmss", () => {
  assert.equal(mmss(0), "0:00");
  assert.equal(mmss(422), "7:02");
});

test("mmss: negative or non-finite input is unknown, shown as an em dash (never 0:00)", () => {
  assert.equal(mmss(-5), "—");
  assert.equal(mmss(Number.NaN), "—");
  assert.equal(mmss(Number.POSITIVE_INFINITY), "—");
});

test("f1: one decimal; unknown is an em dash, never 0.0", () => {
  assert.equal(f1(41.26), "41.3");
  assert.equal(f1(0), "0.0");
  assert.equal(f1(null), "—");
  assert.equal(f1(undefined), "—");
  assert.equal(f1(Number.NaN), "—");
});
