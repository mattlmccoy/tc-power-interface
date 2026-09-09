// VNA auto-tuner that mimics the manual technique: read the Smith position at 13.56 MHz (R + jX) and
// step BOTH caps together toward 50 + j0. A damped Gauss-Newton step with a 2×2 sensitivity
// ∂(R,X)/∂(tune,load) seeded from the 2026-09-09 bench logs and refined online by a Broyden update.
// It is MONOTONIC: every accepted move must lower |Γ(13.56)| (line-searched by halving the step), so it
// can never wander off a good match or wreck one — the failure mode the earlier heuristics had, where
// trialing the hyper-sensitive tune cap (± a huge frequency jump, plus AIT backlash) destroyed a match.
// When the Newton step can't help it falls back to ±1 axial/diagonal probes. Pure + device-agnostic:
// `probe(tune, load)` drives the caps and returns the sweep (hardware or the synthetic model).

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

export type Jac = [[number, number], [number, number]]; // [[∂R/∂T, ∂R/∂L], [∂X/∂T, ∂X/∂L]] (Ω per %)
// Seed (refined online by Broyden): the well-behaved decomposition — TUNE moves reactance X (∂X/∂T
// large; ∂R/∂T is ~0 at resonance, a peak, so useless), LOAD moves resistance R. Signs are a starting
// guess; the monotonic accept + ±1 fallback make a wrong seed harmless (it just falls back to probing).
export const J_SEED: Jac = [[0, -8], [-25, 0.5]];

function solve2x2(J: Jac, b: [number, number]): [number, number] | null {
  const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  if (Math.abs(det) < 1e-6) return null;
  return [(b[0] * J[1][1] - b[1] * J[0][1]) / det, (J[0][0] * b[1] - J[1][0] * b[0]) / det];
}

export interface ShapeOpts {
  maxIters?: number;
  eps?: number; // minimum |Γ| improvement to accept a move
  maxStep?: number; // damping: max % cap move per Newton step
  jacobian?: Jac;
  onStep?: (s: { iter: number; tune: number; load: number; dipHz: number; gammaMin: number; cost: number }) => void;
  shouldStop?: () => boolean;
}
export interface ShapeResult { tune: number; load: number; converged: boolean; iters: number; }
export type ShapeProbe = (tune: number, load: number) => SweepPoint[] | Promise<SweepPoint[]>;

const NEIGHBOURS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export async function shapeTune(probe: ShapeProbe, start: { tune: number; load: number }, opts: ShapeOpts): Promise<ShapeResult> {
  const maxIters = opts.maxIters ?? 60;
  const eps = opts.eps ?? 2e-3;
  const maxStep = opts.maxStep ?? 6;
  const J: Jac = opts.jacobian ? [[...opts.jacobian[0]], [...opts.jacobian[1]]] as Jac : [[...J_SEED[0]], [...J_SEED[1]]] as Jac;

  let tune = clampCap(Math.round(start.tune));
  let load = clampCap(Math.round(start.load));
  let sweep = await probe(tune, load);
  let cost = costAt(sweep);
  let z = zAt(sweep);
  const report = (iter: number) => {
    const d = dipOf(sweep);
    opts.onStep?.({ iter, tune, load, dipHz: d?.freqHz ?? F0, gammaMin: d?.gammaMin ?? cost, cost });
  };
  report(0);
  if (convergedAt(sweep)) return { tune, load, converged: true, iters: 0 };

  for (let iter = 1; iter <= maxIters; iter++) {
    if (opts.shouldStop?.()) return { tune, load, converged: false, iters: iter };
    let moved = false;

    // --- informed Gauss-Newton step toward 50 + j0, damped by halving until it improves ---
    if (z) {
      const full = solve2x2(J, [50 - z.re, -z.im]);
      if (full) {
        const norm = Math.max(Math.abs(full[0]), Math.abs(full[1]), 1e-9);
        for (let scale = Math.min(1, maxStep / norm); scale * norm >= 0.5; scale *= 0.5) {
          const nt = clampCap(tune + Math.round(full[0] * scale));
          const nl = clampCap(load + Math.round(full[1] * scale));
          if (nt === tune && nl === load) continue;
          const trial = await probe(nt, nl);
          const tz = zAt(trial);
          if (costAt(trial) < cost - eps) {
            if (tz && z) { // Broyden rank-1 update of J from the observed (Δcap → ΔZ)
              const dc = [nt - tune, nl - load];
              const dz = [tz.re - z.re, tz.im - z.im];
              const den = dc[0] * dc[0] + dc[1] * dc[1] || 1;
              for (let r = 0; r < 2; r++) {
                const pred = J[r][0] * dc[0] + J[r][1] * dc[1];
                const corr = (dz[r] - pred) / den;
                J[r][0] += corr * dc[0]; J[r][1] += corr * dc[1];
              }
            }
            tune = nt; load = nl; sweep = trial; cost = costAt(trial); z = tz; moved = true; break;
          }
        }
      }
    }

    // --- fallback: ±1 axial / diagonal probes (accept first improving) ---
    if (!moved) {
      for (const [dt, dl] of NEIGHBOURS) {
        const nt = clampCap(tune + dt), nl = clampCap(load + dl);
        if (nt === tune && nl === load) continue;
        const trial = await probe(nt, nl);
        if (costAt(trial) < cost - eps) { tune = nt; load = nl; sweep = trial; cost = costAt(trial); z = zAt(trial); moved = true; break; }
      }
    }

    if (!moved) { await probe(tune, load); report(iter); return { tune, load, converged: convergedAt(sweep), iters: iter }; }
    report(iter);
    if (convergedAt(sweep)) return { tune, load, converged: true, iters: iter };
  }
  return { tune, load, converged: convergedAt(sweep), iters: maxIters };
}
