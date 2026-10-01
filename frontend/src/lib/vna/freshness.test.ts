import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isStaleRepeat, initialReadPolicy, nextReadPolicy, untilFresh, medianGamma, MIN_GAP_MS, MAX_GAP_MS } from "./freshness.ts";
import type { SweepPoint } from "./rf.ts";

type Raw = { f: number; re: number; im: number };
const fx = JSON.parse(readFileSync(new URL("./fixtures/freshness_pairs.json", import.meta.url), "utf8"));
const pts = (s: Raw[]): SweepPoint[] => s.map((p) => ({ frequency: p.f, s11: { re: p.re, im: p.im }, s21: { re: 0, im: 0 } }));

test("REAL v0.12.0 fast reads: a repeat identical in 400 of 401 points is stale", () => {
  assert.equal(isStaleRepeat(pts(fx.stale.a), pts(fx.stale.b)), true);
});

test("REAL v0.7.8 slow reads at the same caps: fresh sweeps differ everywhere (noise), so never stale", () => {
  assert.equal(isStaleRepeat(pts(fx.fresh.a), pts(fx.fresh.b)), false);
});

test("no previous sweep, or a different grid, is not called stale", () => {
  assert.equal(isStaleRepeat(null, pts(fx.stale.b)), false);
  assert.equal(isStaleRepeat([], pts(fx.stale.b)), false);
  assert.equal(isStaleRepeat(pts(fx.stale.a).slice(0, 200), pts(fx.stale.b)), false);
});

test("read policy: a stale fast read switches to the reliable read; stale reliable reads back off; fresh reads speed up", () => {
  let p = initialReadPolicy();
  assert.equal(p.fast, true);
  assert.equal(p.gapMs, MIN_GAP_MS);
  p = nextReadPolicy(p, true);
  assert.equal(p.fast, false);
  assert.equal(p.gapMs, MIN_GAP_MS);
  p = nextReadPolicy(p, true);
  assert.equal(p.gapMs, 250);
  for (let i = 0; i < 10; i++) p = nextReadPolicy(p, true);
  assert.equal(p.gapMs, MAX_GAP_MS);
  assert.equal(p.staleStreak, 12);
  p = nextReadPolicy(p, false);
  assert.equal(p.gapMs, MAX_GAP_MS / 2);
  assert.equal(p.staleStreak, 0);
  assert.equal(p.fast, false); // the reliable read stays for the session once the fast one proved stale
});

test("untilFresh: retries stale reads (waiting the policy gap) and returns the first fresh one", async () => {
  const outcomes = [true, true, false];
  const sleeps: number[] = [];
  let reads = 0;
  const res = await untilFresh({
    readOnce: async () => ({ points: [], stale: outcomes[reads++] }),
    gapMs: () => 100 * reads,
    sleep: async (ms) => { sleeps.push(ms); },
    timeoutMs: 10_000,
    now: () => 0,
  });
  assert.equal(res.stale, false);
  assert.equal(reads, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("untilFresh: gives up with a clear error when the device only repeats itself", async () => {
  let t = 0;
  await assert.rejects(untilFresh({
    readOnce: async () => ({ points: [], stale: true }),
    gapMs: () => 500,
    sleep: async (ms) => { t += ms; },
    timeoutMs: 3000,
    now: () => t,
  }), /stale/);
});

test("medianGamma rejects a one-read glitch (v2 map, T25 L19 read |Γ| 0.83 between ~0.2 neighbours)", () => {
  const g = medianGamma([{ re: -0.21, im: -0.02 }, { re: -0.634, im: 0.536 }, { re: -0.22, im: -0.017 }]);
  assert.deepEqual(g, { re: -0.22, im: -0.017 }); // sorted re: -0.634, -0.22, -0.21
});
