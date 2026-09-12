import assert from "node:assert/strict";
import test from "node:test";

import { alarmShouldSound, alertLevelFor, nextDismissed, shouldChime } from "./alerts.ts";

const base = { state: "connected", rfOn: false, reverseW: 0, maxReflectedW: 25, warnings: [] as string[] };

test("alertLevelFor: a FAULT is always an alarm (covers reflected-extreme, over-temp, interlock, stale)", () => {
  assert.equal(alertLevelFor({ ...base, state: "fault" }), "alarm");
  assert.equal(alertLevelFor({ ...base, state: "fault", rfOn: true, reverseW: 0 }), "alarm");
});

test("alertLevelFor: reflected power in the warn zone (>50% of trip, RF on) chimes", () => {
  assert.equal(alertLevelFor({ ...base, rfOn: true, reverseW: 13, maxReflectedW: 25 }), "chime"); // 13 > 12.5
  assert.equal(alertLevelFor({ ...base, rfOn: true, reverseW: 12, maxReflectedW: 25 }), "none"); // 12 < 12.5
});

test("alertLevelFor: reflected warn only counts while RF is on", () => {
  assert.equal(alertLevelFor({ ...base, rfOn: false, reverseW: 20, maxReflectedW: 25 }), "none");
});

test("alertLevelFor: any advisory warning chimes", () => {
  assert.equal(alertLevelFor({ ...base, warnings: ["reflected fraction 0.03 above warn 0.02"] }), "chime");
});

test("alertLevelFor: a fault outranks a warning (alarm, not chime)", () => {
  assert.equal(alertLevelFor({ ...base, state: "fault", warnings: ["x"] }), "alarm");
});

test("alertLevelFor: guards a zero/absent reflected limit (no divide-by-zero chime)", () => {
  assert.equal(alertLevelFor({ ...base, rfOn: true, reverseW: 5, maxReflectedW: 0 }), "none");
});

test("shouldChime: fires once on the rising edge into chime, not while it persists", () => {
  assert.equal(shouldChime("none", "chime"), true);
  assert.equal(shouldChime("chime", "chime"), false); // no repeat while held
  assert.equal(shouldChime("alarm", "chime"), true); // dropping from alarm back into warn re-chimes
  assert.equal(shouldChime("none", "none"), false);
  assert.equal(shouldChime("chime", "alarm"), false); // escalation is the alarm's job
});

test("alarmShouldSound: sounds on alarm unless dismissed", () => {
  assert.equal(alarmShouldSound("alarm", false), true);
  assert.equal(alarmShouldSound("alarm", true), false);
  assert.equal(alarmShouldSound("chime", false), false);
  assert.equal(alarmShouldSound("none", false), false);
});

test("nextDismissed: a dismiss holds while faulted, auto-clears once the level leaves alarm", () => {
  assert.equal(nextDismissed("alarm", true), true); // still faulted -> stays silenced
  assert.equal(nextDismissed("none", true), false); // cleared -> re-arm for the next fault
  assert.equal(nextDismissed("chime", true), false);
  assert.equal(nextDismissed("alarm", false), false);
});
