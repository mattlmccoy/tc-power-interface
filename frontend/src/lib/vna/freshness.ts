// Stale-read guard for the NanoVNA. Found 2026-10-01: with the fast combined `scan … 0b111` read, the
// device often returns its PREVIOUS sweep again — 400 of 401 points byte-identical, in ~180 ms, at any
// IF bandwidth (1000 Hz read just as fast, so no measurement happened). In every fast-read log since
// v0.5.0, 80-92 % of reads repeated; the live view froze while the caps moved. Reads that took ~840 ms
// (the two-command read) were always fresh, and a read after an idle gap was fresh. A real measurement
// is never byte-identical to the last one (noise moves every point), so identical = stale.

import type { Complex, SweepPoint } from "./rf.ts";

export const MIN_GAP_MS = 30; // the live loop's normal pause between reads
export const MAX_GAP_MS = 2000;
const STALE_FRACTION = 0.95; // share of points that must repeat exactly (point 0 changes even when stale)

/** True when `next` repeats `prev`: same grid and ≥95 % of points with byte-identical S11. */
export function isStaleRepeat(prev: SweepPoint[] | null, next: SweepPoint[]): boolean {
  if (!prev || !prev.length || prev.length !== next.length) return false;
  let same = 0;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    if (a.frequency !== b.frequency) return false;
    if (a.s11.re === b.s11.re && a.s11.im === b.s11.im) same++;
  }
  return same >= STALE_FRACTION * next.length;
}

export interface ReadPolicy {
  fast: boolean; // use the fast combined scan; false = the slower two-command read
  gapMs: number; // pause before the next read
  staleStreak: number;
}

export const initialReadPolicy = (): ReadPolicy => ({ fast: true, gapMs: MIN_GAP_MS, staleStreak: 0 });

/** A stale fast read switches to the two-command read (fresh in every slow log) for the rest of the
 *  session; stale reads after that back off the gap (a read after idle was fresh); fresh reads halve it. */
export function nextReadPolicy(p: ReadPolicy, stale: boolean): ReadPolicy {
  if (!stale) return { fast: p.fast, gapMs: Math.max(MIN_GAP_MS, Math.round(p.gapMs / 2)), staleStreak: 0 };
  if (p.fast) return { fast: false, gapMs: p.gapMs, staleStreak: p.staleStreak + 1 };
  return { fast: false, gapMs: Math.min(MAX_GAP_MS, Math.max(250, p.gapMs * 2)), staleStreak: p.staleStreak + 1 };
}

export interface FreshRead { points: SweepPoint[]; stale: boolean }

/** Read until a fresh (non-repeated) sweep arrives, waiting the policy gap between tries. Throws when
 *  only stale reads come back within `timeoutMs` — callers must not use repeated data as a measurement. */
export async function untilFresh(o: {
  readOnce: () => Promise<FreshRead>;
  gapMs: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  now: () => number;
}): Promise<FreshRead> {
  const t0 = o.now();
  for (;;) {
    const r = await o.readOnce();
    if (!r.stale) return r;
    if (o.now() - t0 >= o.timeoutMs) {
      throw new Error(`NanoVNA returned only stale (repeated) sweeps for ${Math.round((o.now() - t0) / 1000)} s`);
    }
    await o.sleep(o.gapMs());
  }
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Component-wise median: one glitched read among three can't drag the point (unlike the mean). */
export function medianGamma(gs: Complex[]): Complex {
  return { re: med(gs.map((g) => g.re)), im: med(gs.map((g) => g.im)) };
}
