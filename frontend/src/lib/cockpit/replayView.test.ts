import assert from "node:assert/strict";
import { test } from "node:test";

import type { RecordingEvent, ReplayShadowPoint } from "../api.ts";
import type { ReplayRow } from "./replay.ts";
import { cursorIndex, eventsStatus, mergeEvents, recorderEvents, replaySamples, shadowAt, shadowKey, shadowStale, valuesAt } from "./replayView.ts";

const row = (t: number, o: Partial<ReplayRow> = {}): ReplayRow => ({
  t_s: t, forward_w: 40, reverse_w: 0.2, load_w: 39.8, rf_on: true, tune: 20, load: 10, setpoint_w: 40, part_temp_c: 30, ...o,
});
// Shape of GET /api/recordings/{run}/shadow points (backend recording/replay_shadow.py).
const pt = (t: number, o: Partial<ReplayShadowPoint> = {}): ReplayShadowPoint => ({
  t_s: t, temp_c: 35, k_c_per_w: 0.5, tau_s: 150, confidence: 0.7, suggest_w: 60, plateau_c: 50, ...o,
});

test("cursorIndex: last index at or before t; -1 before the first or when empty", () => {
  const ts = [0, 5, 10, 15];
  assert.equal(cursorIndex(ts, 10), 2);
  assert.equal(cursorIndex(ts, 12.5), 2);
  assert.equal(cursorIndex(ts, 99), 3);
  assert.equal(cursorIndex(ts, -1), -1);
  assert.equal(cursorIndex([], 3), -1);
  assert.equal(cursorIndex(ts, Number.NaN), -1);
});

test("valuesAt: the row and the shadow point in force at the cursor", () => {
  const rows = [row(0), row(5, { forward_w: 70 }), row(10)];
  const pts = [pt(0.4), pt(5.2, { suggest_w: 80 })];
  const v = valuesAt(rows, pts, 7);
  assert.equal(v.row!.forward_w, 70);
  assert.equal(v.shadow!.suggest_w, 80);
  assert.deepEqual(valuesAt(rows, pts, -2), { row: null, shadow: null });
  assert.equal(valuesAt(rows, [], 7).shadow, null);
});

test("replaySamples: the chosen ROI's temperature and the suggestion (≥ 30 % confidence) joined within 2 s", () => {
  const rows = [row(0), row(5), row(10, { forward_w: null, rf_on: false }), row(20)];
  const pts = [pt(0.5, { temp_c: 31, confidence: 0.1 }), pt(5, { temp_c: 33 }), pt(10, { temp_c: null })];
  const s = replaySamples(rows, pts);
  assert.deepEqual(s.map((x) => x.ns), [0, 5e9, 10e9, 20e9]);
  assert.deepEqual(s.map((x) => x.part), [31, 33, null, null]); // t=20 has no point within 2 s: unknown
  assert.deepEqual(s.map((x) => x.suggest), [null, 60, 60, null]); // low confidence hides it
  assert.ok(Number.isNaN(s[2].fwd)); // a blank forward is unknown (a gap), never 0
  assert.equal(s[2].rf, false);
  assert.equal(s[0].run, null);
});

test("replaySamples: without a shadow replay the recorded part temperature is used", () => {
  const s = replaySamples([row(0, { part_temp_c: 28 }), row(1, { part_temp_c: null })], null);
  assert.deepEqual(s.map((x) => x.part), [28, null]);
  assert.deepEqual(s.map((x) => x.suggest), [null, null]);
});

test("shadowAt: a replay point as the live Shadow shape; no point or no fit is not valid", () => {
  const sh = shadowAt(pt(5))!;
  assert.equal(sh.valid, true);
  assert.equal(sh.show, true);
  assert.equal(sh.k_c_per_w, 0.5);
  assert.equal(sh.suggest_w, 60);
  assert.equal(sh.t_amb_c, null); // the replay does not report it
  assert.equal(shadowAt(null), null);
  const none = shadowAt(pt(1, { k_c_per_w: null, tau_s: null, confidence: 0 }))!;
  assert.equal(none.valid, false);
  assert.equal(none.show, false);
  assert.equal(none.why, "no estimate yet at this point");
  assert.equal(shadowAt(pt(1, { confidence: 0.2 }))!.show, false);
});

test("shadowAt: carries the honest-confidence and ceiling fields when the replay reports them", () => {
  const sh = shadowAt(pt(5, { confidence: 0.45, confidence_fit: 0.92, drift_pct: 11.3, drifting: true, needed_w: 306, ceiling_w: 200 }))!;
  assert.equal(sh.confidence, 0.45);
  assert.equal(sh.confidence_fit, 0.92);
  assert.equal(sh.drift_pct, 11.3);
  assert.equal(sh.drifting, true);
  assert.equal(sh.needed_w, 306);
  assert.equal(sh.ceiling_w, 200);
  const old = shadowAt(pt(5))!; // an older operator's replay: unknown, not invented
  assert.equal(old.drifting, false);
  assert.equal(old.drift_pct, null);
  assert.equal(old.needed_w, null);
  assert.equal(old.ceiling_w, null);
});

test("shadowKey: one key per (run, ROI, target); nothing to fetch without a ROI or a finite target", () => {
  assert.equal(shadowKey("r1", "SQ_SAMPLE", 55), "r1\u0000SQ_SAMPLE\u000055");
  assert.notEqual(shadowKey("r1", "SQ_SAMPLE", 55), shadowKey("r1", "SQ_SAMPLE", 56));
  assert.equal(shadowKey("r1", "", 55), null);
  assert.equal(shadowKey(null, "SQ_SAMPLE", 55), null);
  assert.equal(shadowKey("r1", "SQ_SAMPLE", Number.NaN), null);
});

// Captured from a recorder events.json (scratch run 20261007_143845, recorder.py:275).
const EVENTS = [
  { host_timestamp_ns: 1791398325795739000, label: "recording_started", data: { name: "RF_20261007_143845" } },
  { host_timestamp_ns: 1791398366724752000, label: "cap_command", data: { axis: "tune", source: "operator", requested: 62.0, readback_before: 0.0, rf_on: false } },
  { host_timestamp_ns: 1791398388236892000, label: "rf_enabled", data: {} },
];

test("recorderEvents: events.json on the telemetry time axis; before the first row is clamped to 0", () => {
  const ns0 = 1791398325789006000n + 10_000_000_000n; // first row 10 s after the recording started
  const ev = recorderEvents(EVENTS, ns0);
  assert.deepEqual(ev.map((e) => e.text), ["recording started", "tune cap → 62 % (operator, was 0 %)", "rf enabled"]);
  assert.equal(ev[0].t_s, 0);
  assert.ok(Math.abs(ev[1].t_s - 30.935746) < 1e-3);
  assert.deepEqual(recorderEvents(EVENTS, null), []); // no origin, no placement
});

test("mergeEvents: time order; a recorder RF event replaces only the derived edge it describes", () => {
  const derived = [{ t_s: 5, text: "RF on" }, { t_s: 9, text: "retune: Tune 20→21 %, Load 10→10 %" }];
  const rec = [{ t_s: 4.9, text: "rf enabled" }, { t_s: 1, text: "recording started" }];
  assert.deepEqual(mergeEvents(derived, rec).map((e) => e.text), ["recording started", "rf enabled", "retune: Tune 20→21 %, Load 10→10 %"]);
  assert.deepEqual(mergeEvents(derived, [{ t_s: 1, text: "recording started" }]).map((e) => e.text),
    ["recording started", "RF on", "retune: Tune 20→21 %, Load 10→10 %"]);
});

test("mergeEvents: an RF-off nobody logged (trip, fault, link loss, timer) stays; the operator's is shown once", () => {
  // The recorder logs RF only for /api/rf/enable|disable (recorder events), so a trip has no event.
  const derived = [
    { t_s: 10, text: "RF on" }, { t_s: 60.4, text: "RF off" }, // operator's RF off (logged at 60)
    { t_s: 70, text: "RF on" }, { t_s: 130, text: "RF off" }, // reflected trip: not logged
  ];
  const rec = [{ t_s: 9.8, text: "rf enabled" }, { t_s: 60, text: "rf disabled" }, { t_s: 69.9, text: "rf enabled" }];
  assert.deepEqual(mergeEvents(derived, rec).map((e) => `${e.t_s} ${e.text}`),
    ["9.8 rf enabled", "60 rf disabled", "69.9 rf enabled", "130 RF off"]);
  // Same direction only: an rf_enabled near a derived RF off does not hide it.
  assert.deepEqual(mergeEvents([{ t_s: 5, text: "RF off" }], [{ t_s: 5.5, text: "rf enabled" }]).map((e) => e.text),
    ["RF off", "rf enabled"]);
  // Beyond 3 s apart they are different edges.
  assert.equal(mergeEvents([{ t_s: 20, text: "RF off" }], [{ t_s: 16.5, text: "rf disabled" }]).length, 2);
});

test("recorderEvents: malformed entries are skipped, never thrown on", () => {
  const bad = [null, 7, "x", { label: 3, host_timestamp_ns: 1 }, { label: "rf_enabled" },
    { label: "rf_disabled", host_timestamp_ns: "soon" }, { label: "cap_command", host_timestamp_ns: 1791398366724752000, data: null },
    EVENTS[2]] as unknown as RecordingEvent[];
  const ns0 = 1791398325789006000n;
  const ev = recorderEvents(bad, ns0);
  assert.deepEqual(ev.map((e) => e.text), ["? cap → ? (?, was ?)", "rf enabled"]);
  assert.deepEqual(recorderEvents({ not: "an array" } as unknown as RecordingEvent[], ns0), []);
});

test("eventsStatus: what the replay says about events.json", () => {
  assert.equal(eventsStatus("ok"), null);
  assert.equal(eventsStatus("missing"), "no events.json (run not stopped cleanly)");
  assert.equal(eventsStatus("error", "Unexpected token < in JSON"), "events.json: Unexpected token < in JSON");
});

test("shadowStale: shown numbers are stale once the request changed, the target was cleared, or the re-run failed", () => {
  const k = shadowKey("r1", "SQ_SAMPLE", 55);
  assert.equal(shadowStale(k, k, false), false);
  assert.equal(shadowStale(k, shadowKey("r1", "SQ_SAMPLE", 60), false), true); // re-running for a new target
  assert.equal(shadowStale(k, null, false), true); // target cleared
  assert.equal(shadowStale(k, k, true), true); // the re-run for this key failed
  assert.equal(shadowStale(null, k, true), false); // nothing shown, nothing stale
});
