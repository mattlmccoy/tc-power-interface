import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReplayShadowPoint } from "../api.ts";
import type { ReplayRow } from "./replay.ts";
import { cursorIndex, replaySamples, shadowAt, shadowKey, valuesAt } from "./replayView.ts";

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

test("shadowKey: one key per (run, ROI, target); nothing to fetch without a ROI or a finite target", () => {
  assert.equal(shadowKey("r1", "SQ_SAMPLE", 55), "r1\u0000SQ_SAMPLE\u000055");
  assert.notEqual(shadowKey("r1", "SQ_SAMPLE", 55), shadowKey("r1", "SQ_SAMPLE", 56));
  assert.equal(shadowKey("r1", "", 55), null);
  assert.equal(shadowKey(null, "SQ_SAMPLE", 55), null);
  assert.equal(shadowKey("r1", "SQ_SAMPLE", Number.NaN), null);
});
