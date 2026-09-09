// 2-D VNA auto-tuner: drives the (Tune, Load) caps so the impedance at 13.56 MHz reaches 50 + j0.
// The matching network is COUPLED (both caps move both R and X), so this optimizes the two caps
// TOGETHER — a damped Gauss-Newton step on the complex error Z → 50 + j0, with a 1% pattern-descent
// that guarantees monotonic progress and lands exactly on the quantized optimum (the v1 1-D law
// ping-ponged across the diagonal valley and stalled; see network_model.ts). Pure and device-agnostic:
// `probe(tune, load)` returns the measured Z (Ω) at those caps — the caller injects real hardware
// (drive caps + sweep) or the synthetic model (tests). Never enables RF.

import { magnitude, vswr, db } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export type Cplx = { re: number; im: number };
export type Jac = [[number, number], [number, number]];
export type Probe = (tune: number, load: number) => Cplx | Promise<Cplx>;

/** Γ from a series impedance Z (Ω), 50 Ω reference. */
export function zToGamma(z: Cplx): Cplx {
  const dr = z.re - 50, di = z.im, sr = z.re + 50, si = z.im;
  const den = sr * sr + si * si || 1e-12;
  return { re: (dr * sr + di * si) / den, im: (di * sr - dr * si) / den };
}

/** Objective: |Γ(13.56)| from Z (→ 0 at a perfect match). */
export function costZ(z: Cplx): number { return magnitude(zToGamma(z)); }

/** Convergence gate: return loss < −20 dB OR VSWR < 1.2. */
export function convergedZ(z: Cplx): boolean {
  const g = zToGamma(z);
  return db(g) < -20 || vswr(g) < 1.2;
}

/** Finite-difference 2×2 sensitivity [[∂R/∂T, ∂R/∂L], [∂X/∂T, ∂X/∂L]]. */
export function estimateJacobian(z0: Cplx, zT: Cplx, zL: Cplx, dT: number, dL: number): Jac {
  return [
    [(zT.re - z0.re) / dT, (zL.re - z0.re) / dL],
    [(zT.im - z0.im) / dT, (zL.im - z0.im) / dL],
  ];
}

/** Solve J·x = b (2×2); null if singular/ill-conditioned. */
export function solve2x2(J: Jac, b: [number, number]): [number, number] | null {
  const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  if (Math.abs(det) < 1e-9) return null;
  return [(b[0] * J[1][1] - b[1] * J[0][1]) / det, (J[0][0] * b[1] - J[1][0] * b[0]) / det];
}

export interface NewtonOpts {
  probeStep?: number; // δ for the finite-difference probes (% cap)
  maxStep?: number; // damping: max |ΔT|,|ΔL| per Newton jump (%)
  maxIters?: number;
  onStep?: (s: { iter: number; tune: number; load: number; cost: number }) => void;
  shouldStop?: () => boolean; // cooperative cancel/guard (RF on, disarmed, user Stop)
}

export interface NewtonResult { tune: number; load: number; converged: boolean; iters: number; }

const NEIGHBOURS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Drive caps to the 13.56 MHz match. Monotonic: every accepted move lowers |Γ|, so it converges to
 *  the quantized optimum without oscillating. Newton accelerates when far; 1% pattern descent finishes. */
export async function newtonTune(probe: Probe, start: { tune: number; load: number }, opts: NewtonOpts): Promise<NewtonResult> {
  const dStep = opts.probeStep ?? 1;
  const maxStep = opts.maxStep ?? 6;
  const maxIters = opts.maxIters ?? 60;
  let tune = clampCap(Math.round(start.tune));
  let load = clampCap(Math.round(start.load));

  for (let iter = 1; iter <= maxIters; iter++) {
    if (opts.shouldStop?.()) return { tune, load, converged: false, iters: iter };
    const z0 = await probe(tune, load);
    const c0 = costZ(z0);
    opts.onStep?.({ iter, tune, load, cost: c0 });
    if (convergedZ(z0)) return { tune, load, converged: true, iters: iter };

    let moved = false;
    // --- Gauss-Newton candidate (coordinated ΔT, ΔL toward 50 + j0) ---
    const zT = await probe(clampCap(tune + dStep), load);
    const zL = await probe(tune, clampCap(load + dStep));
    const sol = solve2x2(estimateJacobian(z0, zT, zL, dStep, dStep), [50 - z0.re, -z0.im]);
    if (sol) {
      const scale = Math.min(1, maxStep / Math.max(Math.abs(sol[0]), Math.abs(sol[1]), 1e-9));
      const nt = clampCap(Math.round(tune + sol[0] * scale));
      const nl = clampCap(Math.round(load + sol[1] * scale));
      if ((nt !== tune || nl !== load) && costZ(await probe(nt, nl)) < c0 - 1e-4) {
        tune = nt; load = nl; moved = true;
      }
    }

    // --- 1% pattern descent (guarantees progress + exact landing) ---
    if (!moved) {
      let best = { t: tune, l: load, c: c0 };
      for (const [dt, dl] of NEIGHBOURS) {
        const nt = clampCap(tune + dt), nl = clampCap(load + dl);
        if (nt === tune && nl === load) continue;
        const c = costZ(await probe(nt, nl));
        if (c < best.c - 1e-4) best = { t: nt, l: nl, c };
      }
      if (best.t === tune && best.l === load) return { tune, load, converged: false, iters: iter }; // local min
      tune = best.t; load = best.l;
    }
  }
  return { tune, load, converged: convergedZ(await probe(tune, load)), iters: maxIters };
}
