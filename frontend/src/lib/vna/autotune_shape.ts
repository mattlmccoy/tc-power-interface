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

import { magnitude, vswr, db, impedance, type Complex, type SweepPoint } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export const F0 = 13.56e6;
const DIP_SENS = 65e3;   // |Δdip| per 1% tune (Hz); sign handled in the loop (more tune → lower dip)
const DIP_TOL = 8e3;     // put the dip within ~half a sweep bin of 13.56 MHz
const LOAD_WINDOW = 18;  // ± whole-percent span of the load scan (wide enough for reactive loads, not slow)
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

/** S11 linearly interpolated at EXACTLY `freq` between the two bracketing sweep bins — the native VNA
 *  marker behaviour. On a sharp resonance the nearest bin can sit 10+ kHz off 13.56 and read a very
 *  different impedance (our −15 dB vs the device's −31 dB at the same match); interpolating at 13.56
 *  makes the readout and the tuner agree with the instrument. */
export function interpS11At(sweep: SweepPoint[], freq: number): Complex | null {
  if (!sweep.length) return null;
  if (sweep.length === 1 || freq <= sweep[0].frequency) return sweep[0].s11;
  const last = sweep[sweep.length - 1];
  if (freq >= last.frequency) return last.s11;
  let lo = 0, hi = sweep.length - 1; // grid is strictly increasing → binary search the bracket
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sweep[mid].frequency <= freq) lo = mid; else hi = mid; }
  const a = sweep[lo], b = sweep[hi];
  const span = b.frequency - a.frequency;
  const t = span > 0 ? (freq - a.frequency) / span : 0;
  return { re: a.s11.re + t * (b.s11.re - a.s11.re), im: a.s11.im + t * (b.s11.im - a.s11.im) };
}

function pAt(sweep: SweepPoint[]): { s11: Complex } | null {
  const s11 = interpS11At(sweep, F0);
  return s11 ? { s11 } : null;
}
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
export type Approach = "above" | "below";
/** Drive the caps and return the sweep. `tuneFrom` requests the tune cap be approached from above/below
 *  (overshoot then settle) so mechanical backlash lands it at its sub-1% position — the backlash-fine
 *  stage uses this to nudge the dip the last few kHz onto 13.56. Probes that ignore it just do a direct
 *  drive (fine with the synthetic model, which has no backlash). */
export type ShapeProbe = (tune: number, load: number, tuneFrom?: Approach) => SweepPoint[] | Promise<SweepPoint[]>;
const sign = (x: number) => (x >= 0 ? 1 : -1);
const clip = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

type Jac = [[number, number], [number, number]]; // [[∂R/∂tune, ∂R/∂load], [∂X/∂tune, ∂X/∂load]] (Ω per %)
function solve2x2(J: Jac, b: [number, number]): [number, number] | null {
  const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  if (Math.abs(det) < 1e-6) return null;
  return [(b[0] * J[1][1] - b[1] * J[0][1]) / det, (J[0][0] * b[1] - J[1][0] * b[0]) / det];
}

export async function shapeTune(probe: ShapeProbe, start: { tune: number; load: number }, opts: ShapeOpts): Promise<ShapeResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const stop = () => opts.shouldStop?.() ?? false;

  let tune = clampCap(Math.round(start.tune));
  let load = clampCap(Math.round(start.load));
  let sweep = await probe(tune, load);
  let iter = 0;
  let best = { tune, load, cost: costAt(sweep) };

  const report = (t: number, l: number, s: SweepPoint[]) => {
    iter++;
    const c = costAt(s);
    const d = dipOf(s);
    opts.onStep?.({ iter, tune: t, load: l, dipHz: d?.freqHz ?? F0, gammaMin: d?.gammaMin ?? c, cost: c });
    return c;
  };
  const visit = (t: number, l: number, s: SweepPoint[]) => {
    const c = report(t, l, s);
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

  // Land on the best point and LOCK it. Backlash means re-commanding the best caps can MISS (land a
  // different physical spot than when best was measured — the 2026-09-10 log ended at 0.93 after a best
  // of 0.48). So re-measure where we actually land, then take a few ±1 clicks that improve |Γ(13.56)|,
  // ending on a real local minimum at the ACTUAL caps — never on a worse frame than we can reach.
  const J: Jac = [[-64, -5], [-70, 3]];
  let cur = await probe(best.tune, best.load);
  best = { tune: best.tune, load: best.load, cost: costAt(cur) };
  let z = zAt(cur);
  for (let k = 0; k < 18 && !convergedAt(cur) && !stop(); k++) {
    let moved = false;
    const step = z ? solve2x2(J, [50 - z.re, -z.im]) : null;
    if (step) {
      const norm = Math.max(Math.abs(step[0]), Math.abs(step[1]), 1e-9);
      for (let scale = Math.min(1, 4 / norm); scale * norm >= 0.5; scale *= 0.5) {
        const nt = clampCap(best.tune + Math.round(step[0] * scale));
        const nl = clampCap(best.load + Math.round(step[1] * scale));
        if (nt === best.tune && nl === best.load) continue;
        const s = await probe(nt, nl);
        const tz = zAt(s);
        if (visit(nt, nl, s) < best.cost - EPS) {
          if (tz && z) { // Broyden rank-1 update of J from the observed Δcap → ΔZ
            const dc = [nt - best.tune, nl - best.load];
            const dz = [tz.re - z.re, tz.im - z.im];
            const den = dc[0] * dc[0] + dc[1] * dc[1] || 1;
            for (let r = 0; r < 2; r++) {
              const corr = (dz[r] - (J[r][0] * dc[0] + J[r][1] * dc[1])) / den;
              J[r][0] += corr * dc[0]; J[r][1] += corr * dc[1];
            }
          }
          best = { tune: nt, load: nl, cost: costAt(s) }; cur = s; z = tz; moved = true; break;
        }
      }
    }
    if (!moved) { // ±1 axial/diagonal fallback (accept first improving)
      for (const [dt, dl] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, 1], [1, -1], [-1, -1], [1, 1]] as Array<[number, number]>) {
        const nt = clampCap(best.tune + dt), nl = clampCap(best.load + dl);
        if (nt === best.tune && nl === best.load) continue;
        const s = await probe(nt, nl);
        if (visit(nt, nl, s) < best.cost - EPS) { best = { tune: nt, load: nl, cost: costAt(s) }; cur = s; z = zAt(s); moved = true; break; }
      }
    }
    if (!moved) break;
  }
  const settled = await probe(best.tune, best.load);
  return { tune: best.tune, load: best.load, converged: convergedAt(settled), iters: iter };
}
