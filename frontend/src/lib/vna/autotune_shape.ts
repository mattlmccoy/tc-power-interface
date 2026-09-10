// VNA auto-tuner built on the PHYSICS, not blind |Γ| search — mirrors how the operator matches by eye.
// The 2026-09-09 bench logs (496 sweeps) showed |Γ(13.56)| is a razor cliff (tune 35.8 → −36 dB,
// 36.2 → −8 dB): searching it directly falls into whatever ledge is nearest. But two signals are smooth
// and monotonic, with no cliffs:
//   • DIP FREQUENCY vs TUNE  — the resonance dip slides ~65 kHz per 1% tune. Reading where the dip sits
//     tells you the tune move directly (no local minima). This is the breakthrough the old search lacked.
//   • R (and |Γ|) vs LOAD    — load sets the coupling; a full load scan at the locked tune finds the
//     match's load with no ridge trap.
// So: PHASE A drives TUNE to put the dip on 13.56 MHz (proportional on the measured dip, damped); PHASE B
// scans LOAD at that tune for the deepest |Γ| (coarse → fine); iterate (load nudges the dip a little).
// Cap drive is DIRECT (see useVna.driveCap), so a down-move lands the backlash-accessible sweet spot the
// operator reaches by hand. BEST-SO-FAR + RESTORE keeps the anti-wander safety: it can explore yet never
// FINISH worse than it started. Validated offline against the real logged surface: 9/9 detunes recover
// to RL < −24 dB. Pure + device-agnostic: `probe(tune, load)` drives the caps and returns the sweep.

import { magnitude, vswr, db, impedance, nearestPointByFrequency, type SweepPoint } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export const F0 = 13.56e6;
const DIP_SENS = 65e3;   // |Δdip| per 1% tune (Hz); sign handled in the loop (more tune → lower dip)
const DIP_TOL = 8e3;     // put the dip within ~half a sweep bin of 13.56 MHz
const LOAD_WINDOW = 26;  // ± whole-percent span of the load scan (wide, for more reactive loads)
const EPS = 1e-3;        // minimum |Γ| improvement to adopt a fine move

export interface Dip { freqHz: number; gammaMin: number; index: number; }

/** Min-|Γ| point of the sweep — the resonance dip. Its FREQUENCY is the tune control signal.
 *  The frequency is refined BELOW the bin size by parabolic interpolation of |Γ| around the minimum,
 *  so a fast low-point-count sweep still locates the dip precisely enough to drive Phase A. */
export function dipOf(sweep: SweepPoint[]): Dip | null {
  if (!sweep.length) return null;
  let bi = 0, bg = Infinity;
  for (let i = 0; i < sweep.length; i++) {
    const g = magnitude(sweep[i].s11);
    if (g < bg) { bg = g; bi = i; }
  }
  let freqHz = sweep[bi].frequency;
  if (bi > 0 && bi < sweep.length - 1) {
    const y0 = magnitude(sweep[bi - 1].s11), y1 = bg, y2 = magnitude(sweep[bi + 1].s11);
    const denom = y0 - 2 * y1 + y2;
    if (denom > 0) {
      const delta = clip(0.5 * (y0 - y2) / denom, -0.5, 0.5); // sub-bin offset in [-0.5, 0.5]
      freqHz += delta * (sweep[bi + 1].frequency - sweep[bi - 1].frequency) / 2;
    }
  }
  return { freqHz, gammaMin: bg, index: bi };
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
  maxRounds?: number;
  onStep?: (s: { iter: number; tune: number; load: number; dipHz: number; gammaMin: number; cost: number }) => void;
  shouldStop?: () => boolean;
}
export interface ShapeResult { tune: number; load: number; converged: boolean; iters: number; }
export type ShapeProbe = (tune: number, load: number) => SweepPoint[] | Promise<SweepPoint[]>;
const sign = (x: number) => (x >= 0 ? 1 : -1);
const clip = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export async function shapeTune(probe: ShapeProbe, start: { tune: number; load: number }, opts: ShapeOpts): Promise<ShapeResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const stop = () => opts.shouldStop?.() ?? false;

  let tune = clampCap(Math.round(start.tune));
  let load = clampCap(Math.round(start.load));
  let sweep = await probe(tune, load);
  let iter = 0;
  let best = { tune, load, cost: costAt(sweep) };

  const visit = (t: number, l: number, s: SweepPoint[]) => {
    iter++;
    const c = costAt(s);
    const d = dipOf(s);
    opts.onStep?.({ iter, tune: t, load: l, dipHz: d?.freqHz ?? F0, gammaMin: d?.gammaMin ?? c, cost: c });
    if (c < best.cost) best = { tune: t, load: l, cost: c };
    return c;
  };
  visit(tune, load, sweep);
  if (convergedAt(sweep)) return { tune, load, converged: true, iters: 0 };

  for (let round = 0; round < maxRounds && !stop(); round++) {
    // ── PHASE A: drive TUNE to put the resonance dip on 13.56 MHz (proportional, damped; no local minima) ──
    for (let a = 0; a < 8 && !stop(); a++) {
      const d = dipOf(sweep);
      if (!d) break;
      const err = d.freqHz - F0;               // dip too high (+) → need more tune (dip drops with tune)
      if (Math.abs(err) < DIP_TOL) break;
      let dt = Math.round(0.8 * err / DIP_SENS); // damped proportional step
      dt = clip(dt, -3, 3) || sign(err);
      const nt = clampCap(tune + dt);
      if (nt === tune) break;
      sweep = await probe(nt, load); tune = nt;
      visit(tune, load, sweep);
    }
    if (convergedAt(sweep)) break;

    // ── PHASE B: at the locked tune, FULL LOAD scan for the deepest |Γ| (coarse → fine) — no ridge trap ──
    let bestLoad = load, bestLoadCost = costAt(sweep);
    for (let l = clampCap(load - LOAD_WINDOW); l <= clampCap(load + LOAD_WINDOW) && !stop(); l += 3) {
      if (l === load) continue;
      const s = await probe(tune, l);
      const c = visit(tune, l, s);
      if (c < bestLoadCost) { bestLoadCost = c; bestLoad = l; }
    }
    if (bestLoad !== load) { load = bestLoad; sweep = await probe(tune, load); visit(tune, load, sweep); }
    // fine ±1 load walk into the null
    for (let f = 0; f < 6 && !stop(); f++) {
      let moved = false;
      for (const dl of [-1, 1]) {
        const nl = clampCap(load + dl);
        if (nl === load) continue;
        const s = await probe(tune, nl);
        if (visit(tune, nl, s) < costAt(sweep) - EPS) { load = nl; sweep = s; moved = true; break; }
      }
      if (!moved) break;
    }
    if (convergedAt(sweep)) break;
  }

  // Command the caps to the best point found and report against it.
  const restore = await probe(best.tune, best.load);
  return { tune: best.tune, load: best.load, converged: convergedAt(restore), iters: iter };
}
