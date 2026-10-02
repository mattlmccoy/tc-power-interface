// "Where did the match go?" During a run the load drifts and the match moves away from where the cold
// map put it. Model: the network keeps the cold map's SHAPE and only its centre moves (the one 09-03
// example: sensitivities 6.8 vs 5.3 Ohm per 0.01 V, nearly the same direction, while the centre moved).
// Since Tune and Load move Z in different directions, a shift of Z0 is equivalent to a shift of the
// whole map in (T, L). For each candidate live-match position M (a grid cell), the shift is
// s = M − coldMatch, and a reading at P should then see the cold map at P − s. Cells where every recent
// reading agrees (within the reflected-power quantization plus the map's own error) are candidates.
// One reading leaves a ring of candidates; two or three readings at different positions narrow it.
// Advisory only: nothing here moves a cap.

import { predictGammaMag, type MapFit } from "./fit.ts";
import type { Reading } from "./track.ts";

export const CELL = { inconsistent: 0, consistent: 1, outside: 2 } as const;
export type LocateStatus = "none" | "matched" | "ring" | "spot" | "nofit";

/** The latest reading at or below this |Γ| (0.25 % reflected) means the operator is on the match now:
 *  any move advice from such readings is noise (2026-10-02 replay: "Tune ↑" right after a correct
 *  downward retune, built from 0.0 W readings). */
export const MATCHED_GAMMA = 0.05;

export interface LocateResult {
  status: LocateStatus;
  grid: { tune: number[]; load: number[] };
  cells: Uint8Array; // row-major [iTune * nLoad + jLoad], values from CELL
  estimate: { tune: number; load: number } | null;
  sigma: number; // |Γ| tolerance per reading (map error), on top of the quantization interval
  // Worst |Γ| the operator would see after moving to the estimate, over every candidate being the
  // truth. Judges ambiguity in the unit that matters: Load is broad, so a wide Load spread costs little.
  worstGamma: number;
  edge: boolean; // candidates touch the uncalibrated area (or the frame): the truth may lie beyond it
}

export const LOCATE_DEFAULTS = {
  tuneStep: 0.05, loadStep: 0.1, // grid resolution (percent)
  tunePad: 1, loadPad: 2, // frame beyond the calibrated range / current position
  tuneMargin: 0.5, loadMargin: 1, // how far past the calibrated range the map may be evaluated
  spotGamma: 0.1, // worst-case |Γ| at the estimate for it to be a usable "spot" (1 W at 100 W)
};

const axis = (lo: number, hi: number, step: number) => {
  const n = Math.max(1, Math.round((hi - lo) / step));
  return Array.from({ length: n + 1 }, (_, k) => lo + (k * (hi - lo)) / n);
};

export function locateMatch(
  fit: MapFit,
  coldMatch: { tune: number; load: number },
  readings: Reading[],
  opts = LOCATE_DEFAULTS,
): LocateResult {
  const P = readings.length ? readings[readings.length - 1] : coldMatch;
  const tune = axis(
    Math.min(fit.tuneRange[0], coldMatch.tune, P.tune) - opts.tunePad,
    Math.max(fit.tuneRange[1], coldMatch.tune, P.tune) + opts.tunePad, opts.tuneStep);
  const load = axis(
    Math.min(fit.loadRange[0], coldMatch.load, P.load) - opts.loadPad,
    Math.max(fit.loadRange[1], coldMatch.load, P.load) + opts.loadPad, opts.loadStep);
  const sigma = 0.015 + (fit.looRmsOhm ?? fit.rmsOhm) / 100; // ~0.01 |Γ| per Ohm near 50 Ohm
  const cells = new Uint8Array(tune.length * load.length);
  const inRange = (t: number, l: number) =>
    t >= fit.tuneRange[0] - opts.tuneMargin && t <= fit.tuneRange[1] + opts.tuneMargin
    && l >= fit.loadRange[0] - opts.loadMargin && l <= fit.loadRange[1] + opts.loadMargin;

  let sT = 0, sL = 0, n = 0;
  tune.forEach((mT, i) => {
    load.forEach((mL, j) => {
      const sTune = mT - coldMatch.tune, sLoad = mL - coldMatch.load;
      let cell: number = CELL.consistent;
      for (const r of readings) {
        const eT = r.tune - sTune, eL = r.load - sLoad;
        if (!inRange(eT, eL)) { cell = CELL.outside; break; }
        const p = predictGammaMag(fit, eT, eL);
        const d = Math.max(0, r.gLo - p, p - r.gHi);
        if (d > 2 * sigma) cell = CELL.inconsistent;
      }
      cells[i * load.length + j] = cell;
      if (cell === CELL.consistent && readings.length) { sT += mT; sL += mL; n++; }
    });
  });

  const grid = { tune, load };
  const latest = readings[readings.length - 1];
  if (latest && latest.g <= MATCHED_GAMMA) {
    return { status: "matched", grid, cells, estimate: { tune: latest.tune, load: latest.load }, sigma, worstGamma: latest.gHi, edge: false };
  }
  if (!readings.length) return { status: "none", grid, cells, estimate: null, sigma, worstGamma: Infinity, edge: false };
  if (!n) return { status: "nofit", grid, cells, estimate: null, sigma, worstGamma: Infinity, edge: false };
  const estimate = { tune: sT / n, load: sL / n };
  const nT = tune.length, nL = load.length;
  let worstGamma = 0;
  let edge = false;
  for (let i = 0; i < nT; i++) {
    for (let j = 0; j < nL; j++) {
      if (cells[i * nL + j] !== CELL.consistent) continue;
      // if this cell is the truth, the live map is the cold map shifted by (cell − cold)
      worstGamma = Math.max(worstGamma, predictGammaMag(fit,
        coldMatch.tune + estimate.tune - tune[i], coldMatch.load + estimate.load - load[j]));
      if (i === 0 || j === 0 || i === nT - 1 || j === nL - 1) { edge = true; continue; }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cells[(i + di) * nL + j + dj] === CELL.outside) edge = true;
      }
    }
  }
  const status: LocateStatus = !edge && worstGamma <= opts.spotGamma ? "spot" : "ring";
  return { status, grid, cells, estimate, sigma, worstGamma, edge };
}

export type Dir = "up" | "down" | "hold" | "unknown";
export interface AxisGuide { dir: Dir; amount: number | null }

export const HOLD = { tune: 0.15, load: 0.5 }; // percent; below the whole-percent step and the map error

/** Which way each cap should go from the operator's current readback `P`. For a spot, from the
 *  estimate. For a ring, only when every candidate lies on the same side; otherwise "unknown". */
export function guide(res: LocateResult, P: { tune: number; load: number }): { tune: AxisGuide; load: AxisGuide } {
  const one = (ax: "tune" | "load"): AxisGuide => {
    if (res.status === "matched") return { dir: "hold", amount: 0 };
    if (res.status === "none" || res.status === "nofit" || !res.estimate) return { dir: "unknown", amount: null };
    const hold = HOLD[ax];
    const c = res.estimate[ax] - P[ax];
    if (res.status === "spot") return { dir: Math.abs(c) <= hold ? "hold" : c > 0 ? "up" : "down", amount: c };
    const { tune, load } = res.grid;
    let lo = Infinity, hi = -Infinity;
    tune.forEach((t, i) => load.forEach((l, j) => {
      if (res.cells[i * load.length + j] !== CELL.consistent) return;
      const d = (ax === "tune" ? t : l) - P[ax];
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }));
    if (lo > hold) return { dir: "up", amount: c };
    if (hi < -hold) return { dir: "down", amount: c };
    if (lo >= -hold && hi <= hold) return { dir: "hold", amount: c };
    return { dir: "unknown", amount: null };
  };
  return { tune: one("tune"), load: one("load") };
}
