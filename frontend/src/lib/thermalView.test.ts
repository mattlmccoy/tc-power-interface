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

test("tempStatusText says why there is no control temperature (null when it is fine)", async () => {
  const { tempStatusText } = await import("./thermalView.ts");
  assert.equal(tempStatusText("ok", "freehand_sample"), null);
  assert.match(tempStatusText("no_roi_selected", null)!, /No control ROI selected/);
  assert.match(tempStatusText("roi_not_in_feed", "circle_medium_small")!, /circle_medium_small.*not drawn in this FLIR session/);
  assert.match(tempStatusText("not_live", "x")!, /not acquiring/);
  assert.match(tempStatusText("no_feed", "x")!, /Can't reach FLIR/);
  assert.match(tempStatusText("roi_invalid", "x")!, /saturated|empty/);
  assert.match(tempStatusText("simulated", null)!, /Simulated/);
  assert.match(tempStatusText(undefined, null)!, /older operator/);
});
