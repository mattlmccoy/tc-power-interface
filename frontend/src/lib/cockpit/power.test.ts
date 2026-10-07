import assert from "node:assert/strict";
import { test } from "node:test";

import { stepSetpoint } from "../instrument.ts";
import { ladderBase } from "./power.ts";

test("ladderBase: which power the ladder step is read from — commanded if known, else forward", () => {
  assert.equal(ladderBase(30, 27.5), 30); // ramping up to 30: still on the 30 W step
  assert.equal(ladderBase(null, 27.5), 27.5);
  assert.ok(Number.isNaN(ladderBase(null, Number.NaN)));
});

test("Next step sends exactly N: the delta is taken against the nudge's own base (setpointRef)", () => {
  // nudgeSetpoint(d) sends stepSetpoint(setpointRef, d, max). With d = N − setpointRef the command is
  // N whatever the box, the commanded value or the forward reading say; any other base is off by
  // their difference (box 100, commanded 30, N 40: base=commanded would send 110).
  for (const ref of [0, 30, 100, 37.5]) assert.equal(stepSetpoint(ref, 40 - ref, 350), 40);
  assert.equal(stepSetpoint(100, 40 - 30, 350), 110); // the wrong base
  assert.equal(stepSetpoint(10, 400 - 10, 350), 350); // still clamped to the ceiling
});
