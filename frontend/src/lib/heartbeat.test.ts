import assert from "node:assert/strict";
import test from "node:test";

import { appHealth, fmtDuration, genHealth, rfClockView } from "./heartbeat.ts";
import type { LinkBlock, RfClockBlock } from "./heartbeat.ts";

const link = (over: Partial<LinkBlock> = {}): LinkBlock => ({
  poll_seq: 10,
  last_ok_age_s: 0.4,
  read_failures: 0,
  ...over,
});

const clock = (over: Partial<RfClockBlock> = {}): RfClockBlock => ({
  rf_on: false,
  burn_s: null,
  last_burn_s: null,
  run_rf_on_s: 0,
  run: null,
  stale: false,
  known: true,
  last_run_rf_on_s: null,
  ...over,
});

test("fmtDuration: m:ss under an hour, h:mm:ss from an hour", () => {
  assert.equal(fmtDuration(0), "0:00");
  assert.equal(fmtDuration(59), "0:59");
  assert.equal(fmtDuration(59.9), "0:59"); // floors, never rounds up to a minute early
  assert.equal(fmtDuration(60), "1:00");
  assert.equal(fmtDuration(252), "4:12");
  assert.equal(fmtDuration(3599), "59:59");
  assert.equal(fmtDuration(3600), "1:00:00");
  assert.equal(fmtDuration(3600 + 61), "1:01:01");
});

test("fmtDuration: dash for null / non-finite, clamps negatives", () => {
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(undefined), "—");
  assert.equal(fmtDuration(Number.NaN), "—");
  assert.equal(fmtDuration(Number.POSITIVE_INFINITY), "—");
  assert.equal(fmtDuration(-3), "0:00");
});

test("genHealth: unknown when not connected or no link block (older backend)", () => {
  assert.equal(genHealth(link(), false).tone, "unknown");
  assert.equal(genHealth(undefined, true).tone, "unknown");
  assert.equal(genHealth(null, true).tone, "unknown");
});

test("genHealth: ok / slow / dead thresholds with the age label", () => {
  assert.deepEqual(genHealth(link({ last_ok_age_s: 0.4 }), true), { tone: "ok", label: "0.4 s" });
  assert.equal(genHealth(link({ last_ok_age_s: 1.5 }), true).tone, "ok");
  assert.equal(genHealth(link({ last_ok_age_s: 1.6 }), true).tone, "slow");
  assert.equal(genHealth(link({ last_ok_age_s: 5.0 }), true).tone, "slow");
  assert.equal(genHealth(link({ last_ok_age_s: 5.1 }), true).tone, "dead");
  assert.deepEqual(genHealth(link({ last_ok_age_s: 7.25 }), true), { tone: "dead", label: "7.3 s" });
});

test("genHealth: a read failure is slow even when the last good read is fresh", () => {
  assert.equal(genHealth(link({ last_ok_age_s: 0.2, read_failures: 1 }), true).tone, "slow");
});

test("genHealth: dead when there has been no good read", () => {
  assert.deepEqual(genHealth(link({ last_ok_age_s: null }), true), { tone: "dead", label: "no read" });
});

test("appHealth: ok up to 2000 ms, dead above, unknown before any message", () => {
  assert.deepEqual(appHealth(120), { tone: "ok", label: "0.1 s" });
  assert.equal(appHealth(2000).tone, "ok");
  assert.equal(appHealth(2001).tone, "dead");
  assert.equal(appHealth(null).tone, "unknown");
});

test("rfClockView: missing block renders nothing", () => {
  assert.equal(rfClockView(undefined), null);
  assert.equal(rfClockView(null), null);
});

test("rfClockView: RF on shows the burn, and the run total while recording", () => {
  assert.deepEqual(rfClockView(clock({ rf_on: true, burn_s: 252, run: "r1", run_rf_on_s: 1120 })), {
    text: "RF ON 4:12 · run 18:40",
    tone: "live",
  });
  assert.deepEqual(rfClockView(clock({ rf_on: true, burn_s: 5 })), { text: "RF ON 0:05", tone: "live" });
});

test("rfClockView: RF off shows the last burn and run total, muted", () => {
  assert.deepEqual(
    rfClockView(clock({ rf_on: false, last_burn_s: 252, run: "r1", run_rf_on_s: 1120 })),
    { text: "RF off · last 4:12 · run 18:40", tone: "muted" },
  );
  assert.deepEqual(rfClockView(clock()), { text: "RF off", tone: "muted" });
});

test("rfClockView: stale wins over any value", () => {
  assert.deepEqual(rfClockView(clock({ rf_on: true, burn_s: 9, stale: true })), {
    text: "RF ? · no data",
    tone: "warn",
  });
});

test("rfClockView: a dead browser link shows no data (the last status is frozen, not live)", () => {
  assert.deepEqual(rfClockView(clock({ rf_on: true, burn_s: 9 }), false), {
    text: "RF ? · no data",
    tone: "warn",
  });
  assert.deepEqual(rfClockView(clock({ rf_on: true, burn_s: 9 }), true), {
    text: "RF ON 0:09",
    tone: "live",
  });
});

test("rfClockView: never connected is neutral, never a warning", () => {
  const never = clock({ rf_on: null, stale: true, known: false });
  assert.deepEqual(rfClockView(never), { text: "RF —", tone: "muted" });
  assert.deepEqual(rfClockView(never, false), { text: "RF —", tone: "muted" });
});

test("rfClockView: connected and fresh renders normally", () => {
  assert.deepEqual(rfClockView(clock({ known: true, rf_on: false })), { text: "RF off", tone: "muted" });
});

test("rfClockView: connected then link lost (known + stale) warns no data", () => {
  assert.deepEqual(rfClockView(clock({ known: true, rf_on: true, burn_s: 9, stale: true })), {
    text: "RF ? · no data",
    tone: "warn",
  });
});

test("rfClockView: after detach (no longer known) is neutral again", () => {
  const detached = clock({ rf_on: null, known: false, stale: true, last_burn_s: 20 });
  assert.deepEqual(rfClockView(detached), { text: "RF —", tone: "muted" });
});

test("rfClockView: older backend without `known` falls back to whether rf_on was seen", () => {
  const legacy = { ...clock({ rf_on: null, stale: true }) } as Partial<RfClockBlock>;
  delete legacy.known;
  assert.deepEqual(rfClockView(legacy as RfClockBlock), { text: "RF —", tone: "muted" });
});

test("rfClockView: after a recording stops, the last run total shows muted", () => {
  assert.deepEqual(
    rfClockView(clock({ rf_on: false, last_burn_s: 252, run: null, last_run_rf_on_s: 1120 })),
    { text: "RF off · last 4:12 · last run 18:40", tone: "muted" },
  );
});
