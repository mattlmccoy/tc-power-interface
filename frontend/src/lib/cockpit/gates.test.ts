import assert from "node:assert/strict";
import { test } from "node:test";

import { engageAllowed, loopGates } from "./gates.ts";

const ok = { runMode: "target", controlRoi: "freehand_sample", tempStatus: "ok", replay: false, confidence: 0.76, liveWatchCount: 2, interlockArmed: false };

test("five gates in a fixed order with honest text", () => {
  const g = loopGates(ok);
  assert.deepEqual(g.map((x) => x.ok), [true, true, true, true, false]);
  assert.equal(g[1].text, "freehand_sample live (stale → 0 W)");
  assert.equal(g[2].text, "Confidence 76 % (needs ≥ 60)");
  assert.equal(g[3].text, "Cores live (2)");
  assert.equal(g[4].text, "Core interlock (not built yet)");
});

test("engage needs every gate; the interlock alone keeps it locked in v0.17", () => {
  assert.equal(engageAllowed(loopGates(ok)), false);
  assert.equal(engageAllowed(loopGates({ ...ok, interlockArmed: true })), true);
});

test("a missing ROI, a stale feed, replay or another run mode each fail their gate", () => {
  assert.equal(loopGates({ ...ok, controlRoi: null })[1].ok, false);
  assert.equal(loopGates({ ...ok, tempStatus: "not_live" })[1].ok, false);
  assert.equal(loopGates({ ...ok, replay: true })[1].ok, false);
  assert.equal(loopGates({ ...ok, runMode: "ladder" })[0].ok, false);
  assert.equal(loopGates({ ...ok, liveWatchCount: 0 })[3].ok, false);
});

test("unknown is never ok: undefined temp status, NaN confidence", () => {
  assert.equal(loopGates({ ...ok, tempStatus: undefined })[1].ok, false);
  const g = loopGates({ ...ok, confidence: Number.NaN });
  assert.equal(g[2].ok, false);
  assert.equal(g[2].text, "Confidence — (needs ≥ 60)");
});

test("no control ROI reads as a name, not as the literal 'No control ROI live'", () => {
  assert.equal(loopGates({ ...ok, controlRoi: null })[1].text, "Control ROI live (stale → 0 W)");
});

test("the interlock gate shows the backend's reason (thermal.engage.reason) when given", () => {
  const reason = "core interlock not built yet (v0.18)";
  assert.equal(loopGates({ ...ok, interlockReason: reason })[4].text, reason);
  assert.equal(loopGates({ ...ok, interlockReason: reason, interlockArmed: true })[4].text, "Core interlock armed");
  assert.equal(loopGates({ ...ok, interlockReason: "" })[4].text, "Core interlock (not built yet)");
});

test("a non-finite live-core count fails its gate", () => {
  assert.equal(loopGates({ ...ok, liveWatchCount: Number.NaN })[3].ok, false);
});
