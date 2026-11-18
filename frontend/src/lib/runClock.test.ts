import assert from "node:assert/strict";
import { test } from "node:test";

import { chipView, fmtClock, overBanner, parseClockEntry, soundFor, type RunClockBlock } from "./runClock.ts";

// Shape of /api/status → run_clock (backend control/run_clock.py RunClock.snapshot).
const base: RunClockBlock = {
  set: true, target_s: 720, on_s: 228, remaining_s: 492, phase: "running", counting: true, dismissed: false,
};
const off: RunClockBlock = {
  set: false, target_s: null, on_s: null, remaining_s: null, phase: "off", counting: false, dismissed: false,
};

test("fmtClock: m:ss under an hour, h:mm:ss above, never negative", () => {
  assert.equal(fmtClock(492), "8:12");
  assert.equal(fmtClock(5), "0:05");
  assert.equal(fmtClock(3723), "1:02:03");
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(-7), "0:07");
});

test("parseClockEntry: minutes and seconds to seconds; nonsense is null", () => {
  assert.equal(parseClockEntry("12", "00"), 720);
  assert.equal(parseClockEntry("12", ""), 720);
  assert.equal(parseClockEntry("", "45"), 45);
  assert.equal(parseClockEntry(" 3 ", "5"), 185);
  for (const [m, s] of [["0", "0"], ["", ""], ["-1", "0"], ["2", "60"], ["1.5", "0"], ["x", "1"], ["1441", "0"]]) {
    assert.equal(parseClockEntry(m, s), null, `${m}:${s}`);
  }
});

test("chipView: counting down, with the target and progress", () => {
  assert.deepEqual(chipView(base), { main: "8:12", sub: "left of 12:00", level: "ok", pct: 31.7 });
});

test("chipView: RF off says paused; warnings keep their colour while paused", () => {
  assert.deepEqual(chipView({ ...base, phase: "paused", counting: false }).sub, "paused · RF off");
  const w = chipView({ ...base, remaining_s: 105, on_s: 615, phase: "warn", counting: false });
  assert.equal(w.level, "warn");
  assert.equal(w.sub, "paused · RF off");
  assert.equal(chipView({ ...base, remaining_s: 24.2, on_s: 695.8, phase: "final" }).main, "0:25"); // ceil
});

test("chipView: overtime counts up and the bar is full", () => {
  const v = chipView({ ...base, remaining_s: -23.6, on_s: 743.6, phase: "over" });
  assert.deepEqual(v, { main: "+0:23", sub: "over 12:00", level: "over", pct: 100 });
});

test("chipView: no clock set is an inviting, muted chip (easy to find)", () => {
  assert.deepEqual(chipView(off), { main: "Run clock", sub: "set RF-on time", level: "idle", pct: 0 });
  assert.deepEqual(chipView(undefined), chipView(off)); // operator older than v0.20: same idle chip
});

test("soundFor: one chime on entering 2 min and 30 s, never on page load", () => {
  assert.deepEqual(soundFor("running", "warn", false), { chime: true, repeat: false });
  assert.deepEqual(soundFor("paused", "warn", false), { chime: true, repeat: false });
  assert.deepEqual(soundFor("warn", "final", false), { chime: true, repeat: false });
  assert.deepEqual(soundFor("warn", "warn", false), { chime: false, repeat: false });
  assert.deepEqual(soundFor(null, "warn", false), { chime: false, repeat: false }); // just opened the page
  assert.deepEqual(soundFor("final", "running", false), { chime: false, repeat: false }); // +time moved it back
});

test("soundFor: time's up repeats until dismissed, even on page load", () => {
  assert.deepEqual(soundFor("final", "over", false), { chime: false, repeat: true });
  assert.deepEqual(soundFor(null, "over", false), { chime: false, repeat: true });
  assert.deepEqual(soundFor("over", "over", true), { chime: false, repeat: false });
  assert.deepEqual(soundFor("over", "off", false), { chime: false, repeat: false }); // cancelled
});

test("overBanner: only when over and not dismissed", () => {
  assert.equal(overBanner({ ...base, remaining_s: -23.6, on_s: 743.6, phase: "over" }),
    "Time's up: 12:00 of RF-on time reached · +0:23 over");
  assert.equal(overBanner({ ...base, remaining_s: -23.6, on_s: 743.6, phase: "over", dismissed: true }), null);
  assert.equal(overBanner(base), null);
  assert.equal(overBanner(undefined), null);
});
