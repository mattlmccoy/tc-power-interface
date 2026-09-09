// Synthetic S11(f; Tune, Load) for the matching network — used ONLY to unit-test the auto-tuner.
// Calibrated to the 2026-09-09 bench logs so the SIGNS and shapes match reality:
//   • the input impedance traces a RESONANCE CIRCLE vs frequency (both R and X vary) —
//       z(f) = g / (1 + jQ·δ),  δ = f/f0 − f0/f   (parallel-resonant form)
//   • TUNE sets the resonant frequency and is INVERSE + sharp: more tune → LOWER f0 (kfT < 0),
//       high Q so ±1% swings Z at 13.56 hard (matches "tune +0.4% → R 51→23").
//   • LOAD sets the coupling g = Rp/50: less load → higher R at resonance (kgL < 0),
//       matches "load 64.7→61.5 → R 50→74" with little frequency shift.
// At (tStar, lStar) and f0*: g=1, δ=0 → z=1 → Γ=0 (a perfect 50 Ω match).

import { impedance, type SweepPoint } from "./rf.ts";

export interface NetworkParams {
  tStar: number; lStar: number; f0: number; q: number;
  kfT: number; kfL: number; // fractional resonance shift per % tune / load
  kgL: number; kgT: number; // normalized-coupling (Rp/50) shift per % load / tune
}

export const DEFAULT_NETWORK: NetworkParams = {
  tStar: 36, lStar: 65, f0: 13.56e6, q: 80,
  kfT: -0.006, kfL: 0.0, // tune: inverse, strong; load barely shifts frequency (it's the R/coupling knob)
  kgL: -0.15, kgT: 0.0,      // load: strong coupling knob; tune: none (its effect is via frequency)
};

export function s11At(freq: number, tune: number, load: number, p: NetworkParams = DEFAULT_NETWORK): { re: number; im: number } {
  const f0 = p.f0 * (1 + p.kfT * (tune - p.tStar) + p.kfL * (load - p.lStar));
  const g = Math.max(0.05, 1 + p.kgL * (load - p.lStar) + p.kgT * (tune - p.tStar));
  const delta = freq / f0 - f0 / freq;
  // z = g / (1 + jQδ)
  const den = 1 + (p.q * delta) ** 2;
  const zr = (g * 1) / den;
  const zi = (-g * p.q * delta) / den;
  // Γ = (z − 1)/(z + 1)
  const nr = zr - 1, ni = zi, dr = zr + 1, di = zi;
  const dden = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / dden, im: (ni * dr - nr * di) / dden };
}

/** Series-equivalent impedance Z (Ω) at 13.56 MHz for (tune, load). */
export function zAt(tune: number, load: number, p: NetworkParams = DEFAULT_NETWORK): { re: number; im: number } {
  return impedance(s11At(p.f0, tune, load, p), 50);
}

export function modelSweep(
  tune: number, load: number,
  opts: { start: number; stop: number; points: number } = { start: 11e6, stop: 16e6, points: 401 },
  p: NetworkParams = DEFAULT_NETWORK,
): SweepPoint[] {
  const { start, stop, points } = opts;
  return Array.from({ length: points }, (_, i) => {
    const frequency = start + ((stop - start) * i) / (points - 1);
    return { frequency, s11: s11At(frequency, tune, load, p), s21: { re: 0, im: 0 } };
  });
}
