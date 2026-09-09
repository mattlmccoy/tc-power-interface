// Shape-based VNA auto-tuner — MONOTONIC backtracking descent on the true objective |Γ(13.56)|.
// Rationale (from real bench logs, 2026-09-09): the earlier heuristic (stop when the dip is "close"
// in frequency) wandered off a perfect manual match because 13.56-adjacent frequency proximity does
// NOT equal a low |Γ(13.56)| for a sharp resonance, and the assumed tune sign was backwards. This
// version only ever ACCEPTS a cap move that lowers |Γ(13.56)|, so it can never wreck a good match or
// wander; it discovers each cap's direction by trial (no sign assumption); and it explores diagonals
// so it climbs down the coupled (tune,load) valley. Each trial is a real cap move + sweep, so it
// backtracks (returns to the best caps) after a non-improving trial. Pure + device-agnostic:
// `probe(tune, load)` drives the caps and returns the sweep (hardware or the synthetic model).
//
// Note the hardware limit: 1% cap steps + AIT backlash place the sharp dip only to ~±0.3%/±25 kHz, so
// the tuner lands CLOSE; the final dB may need a manual nudge. That is physics, not this code.

import { magnitude, vswr, db, nearestPointByFrequency, type SweepPoint } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export const F0 = 13.56e6;

export interface Dip { freqHz: number; gammaMin: number; index: number; }

/** Min-|Γ| point of the sweep (the loop's closest approach to the Smith centre) — used for display. */
export function dipOf(sweep: SweepPoint[]): Dip | null {
  if (!sweep.length) return null;
  let bi = 0, bg = Infinity;
  for (let i = 0; i < sweep.length; i++) {
    const g = magnitude(sweep[i].s11);
    if (g < bg) { bg = g; bi = i; }
  }
  return { freqHz: sweep[bi].frequency, gammaMin: bg, index: bi };
}

/** |Γ| at 13.56 MHz — the objective (→ 0 at a 50 Ω match). */
export function costAt(sweep: SweepPoint[]): number {
  const p = nearestPointByFrequency(sweep, F0);
  return p ? magnitude(p.s11) : 1;
}

/** Convergence gate: return loss < −20 dB OR VSWR < 1.2 at 13.56 MHz. */
export function convergedAt(sweep: SweepPoint[]): boolean {
  const p = nearestPointByFrequency(sweep, F0);
  return !!p && (db(p.s11) < -20 || vswr(p.s11) < 1.2);
}

export interface ShapeOpts {
  maxIters?: number;
  eps?: number; // minimum |Γ| improvement to accept a move
  onStep?: (s: { iter: number; tune: number; load: number; dipHz: number; gammaMin: number; cost: number }) => void;
  shouldStop?: () => boolean;
}

export interface ShapeResult { tune: number; load: number; converged: boolean; iters: number; }
export type ShapeProbe = (tune: number, load: number) => SweepPoint[] | Promise<SweepPoint[]>;

// Trial offsets: single-axis first (cheap, usual case), then the four diagonals (the coupled valley).
const AXIAL: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export async function shapeTune(probe: ShapeProbe, start: { tune: number; load: number }, opts: ShapeOpts): Promise<ShapeResult> {
  const maxIters = opts.maxIters ?? 80;
  const eps = opts.eps ?? 2e-3;
  let tune = clampCap(Math.round(start.tune));
  let load = clampCap(Math.round(start.load));

  let sweep = await probe(tune, load);
  let cost = costAt(sweep);
  const report = (iter: number) => {
    const d = dipOf(sweep);
    opts.onStep?.({ iter, tune, load, dipHz: d?.freqHz ?? F0, gammaMin: d?.gammaMin ?? cost, cost });
  };
  report(0);
  if (convergedAt(sweep)) return { tune, load, converged: true, iters: 0 };

  for (let iter = 1; iter <= maxIters; iter++) {
    if (opts.shouldStop?.()) return { tune, load, converged: false, iters: iter };
    let moved = false;
    for (const [dt, dl] of [...AXIAL, ...DIAGONAL]) {
      if (opts.shouldStop?.()) return { tune, load, converged: false, iters: iter };
      const nt = clampCap(tune + dt), nl = clampCap(load + dl);
      if (nt === tune && nl === load) continue;
      const trial = await probe(nt, nl);
      if (costAt(trial) < cost - eps) {
        tune = nt; load = nl; sweep = trial; cost = costAt(trial); moved = true;
        break; // accept the first improving move; re-scan neighbours next iteration
      }
    }
    if (!moved) { await probe(tune, load); report(iter); return { tune, load, converged: convergedAt(sweep), iters: iter }; }
    report(iter);
    if (convergedAt(sweep)) return { tune, load, converged: true, iters: iter };
  }
  return { tune, load, converged: convergedAt(sweep), iters: maxIters };
}
