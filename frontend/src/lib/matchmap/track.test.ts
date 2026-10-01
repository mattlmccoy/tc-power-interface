import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyTrack, trackSample, TRACK_DEFAULTS, type TelSample, type TrackState } from "./track.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/run193906.json", import.meta.url), "utf8"));
const samples: TelSample[] = fixture.samples;

function replayUntil(tMs: number): TrackState {
  let st = emptyTrack();
  for (const s of samples) { if (s.tMs > tMs) break; st = trackSample(st, s); }
  return st;
}
const close = (a: number, b: number, tol: number, what = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b}`);

test("REAL run 193906: reflected rising at fixed caps keeps one reading at T21.8/L23.6 with the latest value", () => {
  const st = replayUntil(83066);
  const r = st.readings[st.readings.length - 1];
  assert.equal(r.tune, 21.8);
  assert.equal(r.load, 23.6);
  assert.equal(r.rev, 3.6);
  close(r.g, Math.sqrt(3.6 / 100.5), 1e-9, "g");
  assert.equal(st.readings.filter((x) => x.tune === 21.8 && x.load === 23.6).length, 1);
});

test("REAL run 193906: after the Tune step, a new reading at T20.8 reads 0.0 W as an interval, not as zero", () => {
  const st = replayUntil(89645);
  const r = st.readings[st.readings.length - 1];
  assert.equal(r.tune, 20.8);
  assert.equal(r.rev, 0);
  assert.equal(r.gLo, 0);
  close(r.gHi, Math.sqrt(0.05 / 100.5), 1e-9, "gHi"); // 0.1 W resolution: 0.0 means < 0.05 W
  assert.ok(st.readings.some((x) => x.tune === 21.8), "the T21.8 reading is still recent (< 30 s)");
  assert.ok(!st.readings.some((x) => x.tune === 21.0), "the in-motion 21.0 readback never became a reading");
});

test("REAL run 193906: readback creep within the deadband updates the same reading; RF off ends it; old readings expire", () => {
  const st = replayUntil(122702);
  const r = st.readings.find((x) => x.tune === 20.8 && x.load === 23.6);
  assert.ok(r, "the T20.8 reading survives the 20.7/23.5 creep");
  assert.equal(r.rev, 7.6); // last sample before the readback left the deadband (Load 23.4)
  assert.ok(!st.readings.some((x) => x.tune === 21.8), "T21.8 reading expired (> 30 s old)");
  const end = replayUntil(Infinity);
  assert.equal(samples[samples.length - 1].tMs > 122078 + TRACK_DEFAULTS.maxAgeMs, true);
  assert.equal(end.readings.length, 0);
  assert.equal(end.run, null);
});

const s = (tMs: number, over: Partial<TelSample> = {}): TelSample =>
  ({ tMs, rfOn: true, fwd: 100, rev: 2, tune: 30, load: 40, ...over });

test("a position must be held 1.8 s before it counts; RF off or low forward power never counts", () => {
  let st = emptyTrack();
  for (const t of [0, 600, 1200]) st = trackSample(st, s(t));
  assert.equal(st.readings.length, 0);
  st = trackSample(st, s(1800));
  assert.equal(st.readings.length, 1);
  let off = emptyTrack();
  for (const t of [0, 1000, 2000, 3000]) off = trackSample(off, s(t, { rfOn: false }));
  let low = emptyTrack();
  for (const t of [0, 1000, 2000, 3000]) low = trackSample(low, s(t, { fwd: 5 }));
  assert.equal(off.readings.length + low.readings.length, 0);
});

test("keeps at most maxReadings, newest last", () => {
  let st = emptyTrack();
  let t = 0;
  for (let k = 0; k < 9; k++) for (let i = 0; i < 4; i++) { st = trackSample(st, s(t, { tune: 30 + k })); t += 600; }
  assert.equal(st.readings.length, TRACK_DEFAULTS.maxReadings);
  assert.equal(st.readings[st.readings.length - 1].tune, 38);
});
