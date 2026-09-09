import assert from "node:assert/strict";
import { test } from "node:test";

import { appliedLabel, overTempGuard, PHASES, phaseIndex } from "./thermalView.ts";

test("PHASES are the advance-only order and phaseIndex ranks them", () => {
  assert.deepEqual(PHASES, ["ramp", "approach", "soak", "cool", "done"]);
  assert.ok(phaseIndex("approach") > phaseIndex("ramp"));
  assert.ok(phaseIndex("done") > phaseIndex("soak"));
  assert.equal(phaseIndex("bogus"), -1);
});

test("appliedLabel: null is advisory, a number rounds to whole watts", () => {
  assert.equal(appliedLabel(null), "advisory");
  assert.equal(appliedLabel(57.6), "58 W");
  assert.equal(appliedLabel(0), "0 W");
});

test("overTempGuard never reports healthy when max_c is absent", () => {
  assert.deepEqual(overTempGuard(null), { kind: "not-reported" });
  assert.deepEqual(overTempGuard(undefined), { kind: "not-reported" });
  assert.deepEqual(overTempGuard(180.2), { kind: "value", maxC: 180.2 });
});
