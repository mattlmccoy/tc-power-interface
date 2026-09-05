import assert from "node:assert/strict";
import test from "node:test";

import {
  boundHint,
  fmtPct,
  fmtTemp,
  fmtWatts,
  flirStatusLabel,
  formatError,
  reflectedZone,
  statusFlagNames,
} from "./format.ts";

test("boundHint: renders a range when the bound exists", () => {
  assert.equal(boundHint({ target_c: [30, 300] }, "target_c"), " — 30–300");
});

test("boundHint: empty string when bounds missing or key absent (no crash)", () => {
  assert.equal(boundHint(undefined, "target_c"), "");
  assert.equal(boundHint({}, "target_c"), "");
  // a malformed bound (not a 2-tuple) must not throw
  assert.equal(boundHint({ target_c: [] as unknown as [number, number] }, "target_c"), "");
});

test("formatError: extracts a readable message from any thrown value", () => {
  assert.equal(formatError(new Error("boom")), "boom");
  assert.equal(formatError("plain string"), "plain string");
  assert.match(formatError({ weird: 1 }), /weird/);
  assert.equal(formatError(undefined), "Unknown error");
});

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

test("flirStatusLabel: null result or null ok reads as idle", () => {
  assert.equal(flirStatusLabel(null), "idle");
  assert.equal(flirStatusLabel({ ok: null, message: "", ts: 0 }), "idle");
});

test("flirStatusLabel: ok result reads as linked", () => {
  assert.equal(flirStatusLabel({ ok: true, message: "started run r1", ts: 123 }), "linked · ok");
});

test("flirStatusLabel: failed result surfaces the message", () => {
  assert.equal(
    flirStatusLabel({ ok: false, message: "connection refused", ts: 123 }),
    "error: connection refused",
  );
});

test("flirStatusLabel: failed result with empty message falls back", () => {
  assert.equal(flirStatusLabel({ ok: false, message: "", ts: 123 }), "error: unknown");
});
