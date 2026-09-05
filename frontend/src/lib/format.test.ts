import assert from "node:assert/strict";
import test from "node:test";

import { fmtPct, fmtTemp, fmtWatts, reflectedZone, statusFlagNames } from "./format.ts";

test("fmtWatts: one decimal with unit", () => {
  assert.equal(fmtWatts(150), "150.0 W");
  assert.equal(fmtWatts(3.5), "3.5 W");
});

test("fmtPct: fraction to percent with one decimal", () => {
  assert.equal(fmtPct(0.01), "1.0%");
  assert.equal(fmtPct(0), "0.0%");
  assert.equal(fmtPct(0.205), "20.5%");
});

test("fmtTemp: one decimal with degree", () => {
  assert.equal(fmtTemp(30), "30.0 °C");
});

test("reflectedZone: ok/warn/trip thresholds", () => {
  assert.equal(reflectedZone(0.005, 0.02, 0.1), "ok");
  assert.equal(reflectedZone(0.02, 0.02, 0.1), "ok"); // at warn boundary -> still ok
  assert.equal(reflectedZone(0.05, 0.02, 0.1), "warn");
  assert.equal(reflectedZone(0.1, 0.02, 0.1), "warn"); // at trip boundary -> warn
  assert.equal(reflectedZone(0.2, 0.02, 0.1), "trip");
});

test("statusFlagNames: decodes set bits in order", () => {
  assert.deepEqual(statusFlagNames(0), []);
  assert.deepEqual(statusFlagNames(1), ["RF_ENABLED"]);
  assert.deepEqual(statusFlagNames(1 | 2048), ["RF_ENABLED", "INTERLOCK_OPEN"]);
  assert.deepEqual(statusFlagNames(1024), ["OVER_TEMPERATURE"]);
});
