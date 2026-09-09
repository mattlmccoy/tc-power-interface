// VNA auto-tuner that mimics the manual technique AND its global search. The operator reads the Smith
// position at 13.56 MHz and moves LOAD (coupling → R) and TUNE (frequency → reactance) — but crucially
// they will drive a cap THROUGH a worse region to reach a deeper match on the other side of a ridge.
// The 2026-09-09 bench logs proved this: from the auto-tuner's stop point (tune 36 / load 59, |Γ|0.125,
// RL −18) the DEEP match (load ~65, |Γ|0.021, RL −33) sits past a ridge at load ~62 (|Γ|0.24). A greedy
// "never step worse" descent is trapped at 59; a human crosses the ridge every time.
//
// So the law is COORDINATE DESCENT WITH FULL LINE SEARCHES, not greedy ±1 steps: scan the whole LOAD
// axis (coarse, to cross ridges → fine), jump to the global best on that line even if intermediate
// points are worse; then scan the TUNE axis; repeat. The anti-wander safety is preserved not by
// forbidding uphill steps but by BEST-SO-FAR + RESTORE: every point is compared to the best seen, and
// the caps are commanded back to that best at the end — so the tuner can explore a hill yet can never
// FINISH worse than it started (it cannot wreck a good match). Pure + device-agnostic: `probe(tune,
// load)` drives the caps and returns the sweep (real hardware or the synthetic model).

import { magnitude, vswr, db, impedance, nearestPointByFrequency, type SweepPoint } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export const F0 = 13.56e6;

export interface Dip { freqHz: number; gammaMin: number; index: number; }

/** Min-|Γ| point of the sweep (loop's closest approach to the Smith centre) — for display. */
export function dipOf(sweep: SweepPoint[]): Dip | null {
  if (!sweep.length) return null;
  let bi = 0, bg = Infinity;
  for (let i = 0; i < sweep.length; i++) {
    const g = magnitude(sweep[i].s11);
    if (g < bg) { bg = g; bi = i; }
  }
  return { freqHz: sweep[bi].frequency, gammaMin: bg, index: bi };
}

function pAt(sweep: SweepPoint[]) { return nearestPointByFrequency(sweep, F0); }
/** Z (Ω) at 13.56 MHz. */
export function zAt(sweep: SweepPoint[]): { re: number; im: number } | null {
  const p = pAt(sweep); return p ? impedance(p.s11, 50) : null;
}
/** |Γ(13.56)| — the objective (→ 0 at a 50 Ω match). */
export function costAt(sweep: SweepPoint[]): number { const p = pAt(sweep); return p ? magnitude(p.s11) : 1; }
/** Convergence gate: RL < −20 dB OR VSWR < 1.2 at 13.56 MHz. */
export function convergedAt(sweep: SweepPoint[]): boolean {
  const p = pAt(sweep); return !!p && (db(p.s11) < -20 || vswr(p.s11) < 1.2);
}

export interface ShapeOpts {
  eps?: number;         // minimum |Γ| improvement to adopt a new best
  maxRounds?: number;   // load+tune line-search rounds
  loadWindow?: number;  // ± whole-percent span of the load line search
  tuneWindow?: number;  // ± whole-percent span of the tune line search
  onStep?: (s: { iter: number; tune: number; load: number; dipHz: number; gammaMin: number; cost: number }) => void;
  shouldStop?: () => boolean;
}
export interface ShapeResult { tune: number; load: number; converged: boolean; iters: number; }
export type ShapeProbe = (tune: number, load: number) => SweepPoint[] | Promise<SweepPoint[]>;

export async function shapeTune(probe: ShapeProbe, start: { tune: number; load: number }, opts: ShapeOpts): Promise<ShapeResult> {
  const eps = opts.eps ?? 1e-3;
  const maxRounds = opts.maxRounds ?? 3;
  const loadWin = opts.loadWindow ?? 9;
  const tuneWin = opts.tuneWindow ?? 3;

  let bt = clampCap(Math.round(start.tune));   // best caps so far
  let bl = clampCap(Math.round(start.load));
  let bs = await probe(bt, bl);
  let bc = costAt(bs);
  let iter = 0;
  const report = (t: number, l: number, s: SweepPoint[]) => {
    const d = dipOf(s);
    opts.onStep?.({ iter, tune: t, load: l, dipHz: d?.freqHz ?? F0, gammaMin: d?.gammaMin ?? costAt(s), cost: costAt(s) });
  };
  report(bt, bl, bs);
  if (convergedAt(bs)) return { tune: bt, load: bl, converged: true, iters: 0 };

  // A full line search along one axis: scan the whole ±half window (allowed to pass through worse
  // points — that is how it crosses a ridge), keeping the single global best. Returns true if it
  // improved on the incoming best. Centre is the current best on that axis.
  async function line(axis: "tune" | "load", half: number, step: number): Promise<boolean> {
    const centre = axis === "tune" ? bt : bl;
    let improved = false;
    for (let off = -half; off <= half; off += step) {
      if (opts.shouldStop?.()) return improved;
      const t = axis === "tune" ? clampCap(centre + off) : bt;
      const l = axis === "load" ? clampCap(centre + off) : bl;
      if (t === bt && l === bl) continue;
      iter++;
      const s = await probe(t, l);
      const c = costAt(s);
      report(t, l, s);
      if (c < bc - eps) { bc = c; bt = t; bl = l; bs = s; improved = true; if (convergedAt(s)) return improved; }
    }
    return improved;
  }

  for (let r = 0; r < maxRounds; r++) {
    if (opts.shouldStop?.()) break;
    // LOAD first (coupling / R sets the basin): coarse to cross any ridge, then fine.
    let improved = await line("load", loadWin, 3);
    if (convergedAt(bs) || opts.shouldStop?.()) break;
    improved = (await line("load", 2, 1)) || improved;
    if (convergedAt(bs) || opts.shouldStop?.()) break;
    // TUNE (frequency / reactance).
    const tunedUp = await line("tune", tuneWin, 1);
    if (convergedAt(bs)) break;
    if (!improved && !tunedUp) break; // neither axis moved → settled at the best point
  }

  // Command the caps back to the best point found (the last probe may have left them on a worse one).
  const restore = await probe(bt, bl);
  return { tune: bt, load: bl, converged: convergedAt(restore), iters: iter };
}
