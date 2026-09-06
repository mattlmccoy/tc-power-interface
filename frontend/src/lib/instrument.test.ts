import assert from "node:assert/strict";
import test from "node:test";

import {
  capVolts,
  clampCap,
  clampPercent,
  gaugeAngle,
  generatorModes,
  LOAD_VOLTS,
  statusLeds,
  tempBar,
  TUNE_VOLTS,
} from "./instrument.ts";

test("capVolts maps cap % to control voltage (validated: TC 36%->1.85V, LC 49%->~2.47V)", () => {
  // Bench match 2026-09-04 (S1P title T1.85/L2.46 at generator TC=36%, LC=49%).
  assert.ok(Math.abs(capVolts(36, TUNE_VOLTS) - 1.85) < 0.01);
  assert.ok(Math.abs(capVolts(49, LOAD_VOLTS) - 2.47) < 0.01);
  assert.equal(capVolts(0, TUNE_VOLTS), 0.12);
  assert.equal(capVolts(100, LOAD_VOLTS), 4.93);
  // clamps out-of-range
  assert.equal(capVolts(-10, TUNE_VOLTS), 0.12);
  assert.equal(capVolts(150, TUNE_VOLTS), 4.92);
});

test("tempBar: fraction from room->max, green at bottom to red at top, clamped", () => {
  assert.equal(tempBar(25, 25, 70).fraction, 0);
  assert.equal(tempBar(70, 25, 70).fraction, 1);
  assert.ok(Math.abs(tempBar(47.5, 25, 70).fraction - 0.5) < 1e-9);
  assert.equal(tempBar(10, 25, 70).fraction, 0); // below room clamps to 0
  assert.equal(tempBar(999, 25, 70).fraction, 1); // above max clamps to 1
  // hue goes 120 (green) -> 0 (red) as fraction rises
  assert.match(tempBar(25, 25, 70).color, /hsl\(120/);
  assert.match(tempBar(70, 25, 70).color, /hsl\(0/);
});

test("tempBar: degenerate range does not divide by zero", () => {
  assert.equal(tempBar(50, 70, 70).fraction, 0);
});

test("generatorModes reads RF-source and leveling from the status bits", () => {
  assert.deepEqual(generatorModes(0), { rfSource: "internal", leveling: "forward" });
  assert.equal(generatorModes(16).rfSource, "external"); // EXTERNAL_RFSOURCE
  assert.equal(generatorModes(32).leveling, "load"); // LOAD_POWER_LEVELING
  assert.deepEqual(generatorModes(16 | 32), { rfSource: "external", leveling: "load" });
});

test("gaugeAngle maps value across the arc and clamps out-of-range", () => {
  assert.equal(gaugeAngle(0, 0, 600, -120, 120), -120); // min -> start
  assert.equal(gaugeAngle(600, 0, 600, -120, 120), 120); // max -> end
  assert.equal(gaugeAngle(300, 0, 600, -120, 120), 0); // midpoint
  assert.equal(gaugeAngle(-50, 0, 600, -120, 120), -120); // below range clamps
  assert.equal(gaugeAngle(9999, 0, 600, -120, 120), 120); // above range clamps
});

test("gaugeAngle handles a degenerate range without dividing by zero", () => {
  assert.equal(gaugeAngle(5, 10, 10, -120, 120), -120);
});

test("clampCap clamps to 0..100 at 0.1% resolution; NaN -> 0", () => {
  assert.equal(clampCap(42.54), 42.5);
  assert.equal(clampCap(42.55), 42.6);
  assert.equal(clampCap(-3), 0);
  assert.equal(clampCap(140), 100);
  assert.equal(clampCap(Number.NaN), 0);
});

test("clampPercent clamps to 0..100 and rounds; NaN -> 0", () => {
  assert.equal(clampPercent(50.4), 50);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(140), 100);
  assert.equal(clampPercent(Number.NaN), 0);
});

test("statusLeds derives LED states from the CXN status bits", () => {
  const off = statusLeds(0);
  assert.equal(off.length, 5);
  assert.deepEqual(
    off.map((l) => l.label),
    ["RF on", "Forward limit", "Reverse limit", "Overheat", "Interlock"],
  );
  assert.ok(off.every((l) => l.on === false && l.tone === "off"));

  const rfOn = statusLeds(1); // RF_ENABLED
  assert.equal(rfOn[0].on, true);
  assert.equal(rfOn[0].tone, "ok");

  const revLimit = statusLeds(512); // REVERSE_POWER_LIMIT
  const rev = revLimit.find((l) => l.label === "Reverse limit");
  assert.equal(rev?.on, true);
  assert.equal(rev?.tone, "warn");
});
