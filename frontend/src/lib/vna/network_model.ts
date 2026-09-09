// Synthetic S11(f; Tune, Load) for a COUPLED matching network — used ONLY to unit-test the 2-D
// auto-tuner (never shipped to hardware). The physics that broke the v1 1-D law: both caps move both
// the resonant frequency AND the coupling, so the match is a diagonal valley in (Tune, Load).
//
//   f0(T,L) = f0* · (1 + kfT·(T−T*) + kfL·(L−L*))     both caps shift resonance
//   r (norm) = 1  + krT·(T−T*) + krL·(L−L*)            both caps shift the resonant resistance
//   z(f)     = r + j·Q·(f/f0 − f0/f)                   sharp reactance slope (high Q = "tune is sharp")
//   Γ        = (z−1)/(z+1)                             normalized to 50 Ω
// At (T*,L*) and f0*: z = 1 → Γ = 0 (a perfect match). The cross terms (kfL, krT) are the coupling.

import { impedance, type SweepPoint } from "./rf.ts";

export interface NetworkParams {
  tStar: number; // optimum tune (%)
  lStar: number; // optimum load (%)
  f0: number; // resonant frequency at the optimum (Hz)
  q: number; // resonator Q (reactance sharpness)
  kfT: number; // fractional resonance shift per % tune
  kfL: number; // fractional resonance shift per % load (coupling)
  krT: number; // normalized-R shift per % tune (coupling)
  krL: number; // normalized-R shift per % load
}

export const DEFAULT_NETWORK: NetworkParams = {
  tStar: 44,
  lStar: 44,
  f0: 13.56e6,
  q: 26,
  kfT: 0.010,
  kfL: 0.004,
  krT: -0.012,
  krL: 0.030,
};

/** Complex S11 (Γ) at one frequency for cap positions (tune, load). */
export function s11At(freq: number, tune: number, load: number, p: NetworkParams = DEFAULT_NETWORK): { re: number; im: number } {
  const f0 = p.f0 * (1 + p.kfT * (tune - p.tStar) + p.kfL * (load - p.lStar));
  const r = Math.max(0.02, 1 + p.krT * (tune - p.tStar) + p.krL * (load - p.lStar));
  const x = p.q * (freq / f0 - f0 / freq);
  const denom = (r + 1) ** 2 + x ** 2;
  return { re: (r * r - 1 + x * x) / denom, im: (2 * x) / denom };
}

/** Series-equivalent impedance Z (Ω) at 13.56 MHz for (tune, load) — the quantity the tuner targets. */
export function zAt(tune: number, load: number, p: NetworkParams = DEFAULT_NETWORK): { re: number; im: number } {
  return impedance(s11At(p.f0, tune, load, p), 50);
}

/** A full synthetic sweep for feeding the Smith / S11 plot / gammaAt in tests. */
export function modelSweep(
  tune: number,
  load: number,
  opts: { start: number; stop: number; points: number } = { start: 12e6, stop: 18e6, points: 201 },
  p: NetworkParams = DEFAULT_NETWORK,
): SweepPoint[] {
  const { start, stop, points } = opts;
  return Array.from({ length: points }, (_, i) => {
    const frequency = start + ((stop - start) * i) / (points - 1);
    return { frequency, s11: s11At(frequency, tune, load, p), s21: { re: 0, im: 0 } };
  });
}
