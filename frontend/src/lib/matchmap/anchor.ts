// Re-anchoring a captured map. The network's match moves between sessions (re-matching by hand, a new
// part), but the map's SHAPE holds: one VNA reading — complex Z at a known cap readback — gives two real
// equations for the two unknowns of a map shift (ΔTune, ΔLoad). Checked on real data: the 10-01 map,
// anchored with ONE point from the 10-02 rematch capture, predicted the other 14 points with median miss
// 0.9 Ohm (11.6 Ohm unanchored) — as good as a fresh capture. A shift is the same as moving the fit's
// centring offsets, so the anchored map is just the fit with t0/l0 (and its ranges) moved.

import type { Complex } from "../vna/rf.ts";
import { predictZ, type MapFit } from "./fit.ts";

export class AnchorError extends Error {}

export interface AnchorShift { sT: number; sL: number; residualOhm: number }

export const ANCHOR_LIMITS = {
  maxResidualOhm: 2, // a shift must reproduce the reading this closely, or the network changed shape
  maxShift: 20, // percent; beyond this the map is not this network any more
};

/** The map moved by (sT, sL): it now predicts Z(T, L) = Z_map(T − sT, L − sL). */
export function shiftFit(fit: MapFit, sT: number, sL: number): MapFit {
  return {
    ...fit,
    t0: fit.t0 + sT, l0: fit.l0 + sL,
    tuneRange: [fit.tuneRange[0] + sT, fit.tuneRange[1] + sT],
    loadRange: [fit.loadRange[0] + sL, fit.loadRange[1] + sL],
  };
}

/** Solve the shift so the map reproduces `z` measured at readback `at` (damped Newton, numeric
 *  Jacobian). Throws AnchorError when no shift within the limits reproduces the reading. */
export function solveAnchor(fit: MapFit, at: { tune: number; load: number }, z: Complex, lim = ANCHOR_LIMITS): AnchorShift {
  const f = (sT: number, sL: number) => predictZ(fit, at.tune - sT, at.load - sL);
  let sT = 0, sL = 0;
  for (let k = 0; k < 60; k++) {
    const p = f(sT, sL), h = 1e-3;
    const pt = f(sT + h, sL), pl = f(sT, sL + h);
    const a = (pt.re - p.re) / h, b = (pl.re - p.re) / h, c = (pt.im - p.im) / h, d = (pl.im - p.im) / h;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const rRe = z.re - p.re, rIm = z.im - p.im;
    let dT = (rRe * d - b * rIm) / det, dL = (a * rIm - rRe * c) / det;
    const n = Math.hypot(dT, dL);
    if (n > 2) { dT *= 2 / n; dL *= 2 / n; } // damp big steps: the map is only valid near its data
    sT += dT; sL += dL;
    if (n < 1e-7) break;
  }
  const p = f(sT, sL);
  const residualOhm = Math.hypot(p.re - z.re, p.im - z.im);
  if (!Number.isFinite(residualOhm) || residualOhm > lim.maxResidualOhm || Math.hypot(sT, sL) > lim.maxShift) {
    throw new AnchorError(
      `no shift of this map reproduces the reading (best leaves ${Number.isFinite(residualOhm) ? residualOhm.toFixed(1) : "∞"} Ohm) — the network changed shape: capture a new map`);
  }
  return { sT, sL, residualOhm };
}
