import assert from "node:assert/strict";
import { test } from "node:test";

import { appendSample, type CockpitSample } from "./history.ts";

const s = (ns: number, run: string | null = "r1"): CockpitSample => ({
  ns, run, rf: true, fwd: 40, rev: 0.1, part: 41, watch: {}, suggest: null, tune: 20, load: 10,
});

test("dedupes by telemetry timestamp, caps the length, resets on a new run", () => {
  let b: CockpitSample[] = [];
  b = appendSample(b, s(1), 3);
  b = appendSample(b, s(1), 3); // same telemetry sample re-sent by the 10 Hz websocket
  assert.equal(b.length, 1);
  for (const ns of [2, 3, 4]) b = appendSample(b, s(ns), 3);
  assert.deepEqual(b.map((x) => x.ns), [2, 3, 4]);
  b = appendSample(b, s(5, "r2"), 3);
  assert.deepEqual(b.map((x) => x.ns), [5]);
});

test("a sample older than the last one (out of order) is ignored", () => {
  let b: CockpitSample[] = [];
  for (const ns of [10, 20, 30]) b = appendSample(b, s(ns), 10);
  const same = appendSample(b, s(15), 10);
  assert.equal(same, b); // untouched, same reference: React sees no change
  assert.deepEqual(same.map((x) => x.ns), [10, 20, 30]);
});

test("a sample with no run (recording stopped / unknown) keeps the buffer", () => {
  let b: CockpitSample[] = [];
  b = appendSample(b, s(1, "r1"), 10);
  b = appendSample(b, s(2, "r1"), 10);
  b = appendSample(b, s(3, null), 10);
  assert.deepEqual(b.map((x) => x.ns), [1, 2, 3]);
});

test("does not mutate the input buffer", () => {
  const b = appendSample([], s(1), 10);
  const b2 = appendSample(b, s(2), 10);
  assert.equal(b.length, 1);
  assert.equal(b2.length, 2);
  assert.notEqual(b, b2);
});

test("starting a recording (null -> r1) keeps the pre-recording timeline", () => {
  let b: CockpitSample[] = [];
  for (const [ns, run] of [[1, null], [2, null], [3, "r1"]] as const) b = appendSample(b, s(ns, run), 10);
  assert.deepEqual(b.map((x) => x.ns), [1, 2, 3]);
});

test("only a switch between two DIFFERENT runs resets; r1 -> null -> r1 keeps, r1 -> null -> r2 resets", () => {
  let b: CockpitSample[] = [];
  for (const [ns, run] of [[1, "r1"], [2, "r2"]] as const) b = appendSample(b, s(ns, run), 10);
  assert.deepEqual(b.map((x) => x.ns), [2]);
  let k: CockpitSample[] = [];
  for (const [ns, run] of [[1, "r1"], [2, null], [3, "r1"]] as const) k = appendSample(k, s(ns, run), 10);
  assert.deepEqual(k.map((x) => x.ns), [1, 2, 3]);
  let r: CockpitSample[] = [];
  for (const [ns, run] of [[1, "r1"], [2, null], [3, "r2"]] as const) r = appendSample(r, s(ns, run), 10);
  assert.deepEqual(r.map((x) => x.ns), [3]);
});
