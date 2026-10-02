// Cold match map: a local least-squares model of the network impedance Z(T, L) at 13.56 MHz as a
// function of the Tune/Load cap READBACK (percent), fitted from settled VNA points taken around the
// match. Z (not |Γ|) is modelled because it is close to linear in cap position (09-03 study: a map built
// from single-cap moves predicted held-out combined moves within 0.5-2.2 Ohm), while |Γ| is not.
// See experiments/.../2026-09-30_COLD_MATCH_MAP_FEASIBILITY_ANALYSIS.md.

import type { Complex } from "../vna/rf.ts";

export interface MapPoint {
  tune: number; // readback %, not the command (a 20.0 % command settled at 20.8 % on 09-28)
  load: number;
  g: Complex; // S11 at exactly 13.56 MHz
}

export type FitKind = "linear" | "quadratic" | "cubic";
export type FitSpace = "Z" | "gamma";

export interface MapFit {
  kind: FitKind;
  space: FitSpace; // which quantity is the polynomial: impedance Z or reflection Γ (picked by held-out error)
  t0: number; // centring offsets for conditioning
  l0: number;
  cRe: number[]; // coefficients on [1, dT, dL, (dT², dL², dT·dL, (dT³, dL³, dT²·dL, dT·dL²))]
  cIm: number[];
  n: number;
  rmsOhm: number; // in-sample |Z_fit - Z_meas| RMS
  looRmsOhm: number | null; // leave-one-out RMS (null when a fold is unidentifiable)
  tuneRange: [number, number];
  loadRange: [number, number];
}

/** Both caps must move by at least this much (percent): 3x the ±0.1 % readback flicker. */
export const MIN_SPREAD = 0.3;
const Z0 = 50;

export class MapFitError extends Error {}

export function zOfGamma(g: Complex): Complex {
  const den = (1 - g.re) ** 2 + g.im ** 2;
  return { re: (Z0 * (1 - g.re ** 2 - g.im ** 2)) / den, im: (Z0 * 2 * g.im) / den };
}

export function gammaOfZ(z: Complex): Complex {
  const nr = z.re - Z0, ni = z.im;
  const dr = z.re + Z0, di = z.im;
  const den = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

function basis(kind: FitKind, dT: number, dL: number): number[] {
  if (kind === "linear") return [1, dT, dL];
  const q = [1, dT, dL, dT * dT, dL * dL, dT * dL];
  return kind === "quadratic" ? q : [...q, dT * dT * dT, dL * dL * dL, dT * dT * dL, dT * dL * dL];
}

/** Solve the square system M x = b by Gaussian elimination with partial pivoting; null if singular. */
function solve(M: number[][], b: number[]): number[] | null {
  const n = b.length;
  const A = M.map((row, i) => [...row, b[i]]);
  const scale = Math.max(1e-300, ...M.map((r) => Math.max(...r.map(Math.abs))));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9 * scale) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

interface Core { kind: FitKind; space: FitSpace; t0: number; l0: number; cRe: number[]; cIm: number[] }

function leastSquares(kind: FitKind, space: FitSpace, pts: MapPoint[], t0: number, l0: number): Core | null {
  const rows = pts.map((p) => basis(kind, p.tune - t0, p.load - l0));
  const zs = pts.map((p) => (space === "Z" ? zOfGamma(p.g) : p.g));
  const m = rows[0].length;
  if (pts.length < m) return null;
  const AtA = Array.from({ length: m }, (_, i) =>
    Array.from({ length: m }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const Atb = (pick: (z: Complex) => number) =>
    Array.from({ length: m }, (_, i) => rows.reduce((s, r, k) => s + r[i] * pick(zs[k]), 0));
  const cRe = solve(AtA, Atb((z) => z.re));
  const cIm = solve(AtA, Atb((z) => z.im));
  return cRe && cIm ? { kind, space, t0, l0, cRe, cIm } : null;
}

/** The polynomial's own value (Z or Γ, per c.space). */
function evalRaw(c: Core, tune: number, load: number): Complex {
  const b = basis(c.kind, tune - c.t0, load - c.l0);
  return {
    re: b.reduce((s, v, i) => s + v * c.cRe[i], 0),
    im: b.reduce((s, v, i) => s + v * c.cIm[i], 0),
  };
}

function evalCore(c: Core, tune: number, load: number): Complex {
  const v = evalRaw(c, tune, load);
  return c.space === "Z" ? v : zOfGamma(v);
}

const zMiss = (c: Core, p: MapPoint) => {
  const zp = evalCore(c, p.tune, p.load);
  const zm = zOfGamma(p.g);
  return Math.hypot(zp.re - zm.re, zp.im - zm.im);
};

const KINDS: FitKind[] = ["linear", "quadratic", "cubic"];
const SPACES: FitSpace[] = ["Z", "gamma"];
const nTerms = (k: FitKind) => basis(k, 0, 0).length;

/** Fit the map: every model (Z or Γ; linear, quadratic, cubic) the points can identify with room to
 *  spare is fitted, and the one with the lowest leave-one-out error (Ohm) wins — simpler first on ties.
 *  On the first real 218-2core captures Γ-space beat the Z quadratic (2.3 vs 3.35 Ohm held-out), and
 *  a wide Tune span needs the cubic. A layout that can't identify a model (a star has no cross term)
 *  simply drops that candidate. */
export function fitMap(points: MapPoint[]): MapFit {
  if (points.length < 4) throw new MapFitError(`need at least 4 points (got ${points.length})`);
  const ts = points.map((p) => p.tune), ls = points.map((p) => p.load);
  const tuneRange: [number, number] = [Math.min(...ts), Math.max(...ts)];
  const loadRange: [number, number] = [Math.min(...ls), Math.max(...ls)];
  const sT = tuneRange[1] - tuneRange[0], sL = loadRange[1] - loadRange[0];
  if (sT < MIN_SPREAD || sL < MIN_SPREAD) {
    throw new MapFitError(
      `both caps need a spread of at least ${MIN_SPREAD} % (Tune ${sT.toFixed(2)} %, Load ${sL.toFixed(2)} %)`);
  }
  const t0 = ts.reduce((a, b) => a + b, 0) / ts.length;
  const l0 = ls.reduce((a, b) => a + b, 0) / ls.length;

  let best: MapFit | null = null;
  for (const kind of KINDS) {
    if (kind !== "linear" && points.length < nTerms(kind) + 2) continue; // need spare points to judge it
    for (const space of SPACES) {
      const core = leastSquares(kind, space, points, t0, l0);
      if (!core) continue;
      let sq = 0;
      let ok = true;
      for (let i = 0; i < points.length && ok; i++) {
        const c = leastSquares(kind, space, points.filter((_, k) => k !== i), t0, l0);
        if (!c) ok = false;
        else sq += zMiss(c, points[i]) ** 2;
      }
      const looRmsOhm = ok ? Math.sqrt(sq / points.length) : null;
      const rmsOhm = Math.sqrt(points.reduce((s, p) => s + zMiss(core, p) ** 2, 0) / points.length);
      const fit: MapFit = { ...core, n: points.length, rmsOhm, looRmsOhm, tuneRange, loadRange };
      const score = (f: MapFit) => f.looRmsOhm ?? Infinity;
      if (!best || score(fit) < score(best) - 1e-6) best = fit;
    }
  }
  if (!best) throw new MapFitError("points do not identify a map (collinear layout?)");
  return best;
}

export function predictZ(fit: MapFit, tune: number, load: number): Complex {
  return evalCore(fit, tune, load);
}

export function predictGammaMag(fit: MapFit, tune: number, load: number): number {
  const g = fit.space === "gamma" ? evalRaw(fit, tune, load) : gammaOfZ(predictZ(fit, tune, load));
  return Math.hypot(g.re, g.im);
}

/** Where the map predicts the best match (minimum |Γ|), searched over the calibrated range widened
 *  by half its span on each side, by a coarse grid then two refinements. */
export function solveMatch(fit: MapFit): { tune: number; load: number; gamma: number } {
  const pad = (r: [number, number]) => {
    const h = Math.max(0.5, (r[1] - r[0]) / 2);
    return [r[0] - h, r[1] + h] as [number, number];
  };
  let [tLo, tHi] = pad(fit.tuneRange);
  let [lLo, lHi] = pad(fit.loadRange);
  let best = { tune: (tLo + tHi) / 2, load: (lLo + lHi) / 2, gamma: Infinity };
  const N = 60;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const tune = tLo + ((tHi - tLo) * i) / N, load = lLo + ((lHi - lLo) * j) / N;
        const gamma = predictGammaMag(fit, tune, load);
        if (gamma < best.gamma) best = { tune, load, gamma };
      }
    }
    const wT = (tHi - tLo) / 10, wL = (lHi - lLo) / 10;
    [tLo, tHi, lLo, lHi] = [best.tune - wT, best.tune + wT, best.load - wL, best.load + wL];
  }
  return best;
}
