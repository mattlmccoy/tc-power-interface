// Shape-based VNA auto-tuner. Instead of probing the caps to build a Jacobian (slow: many cap moves
// per step), it reads the SHAPE of the whole S11 sweep each iteration and moves the caps directly —
// exactly the manual technique: watch the resonance loop, TUNE slides the dip onto 13.56 MHz (align
// the loop's crossing to the centre frequency) and LOAD opens the loop until the dip reaches 50 Ω
// (depth → 0). One cap move + one sweep per step, no probing ⇒ seconds, not minutes. The tune gain is
// learned by secant; the load direction self-corrects if a step makes the dip shallower. Pure and
// device-agnostic: `probe(tune, load)` returns the sweep at those caps (real hardware or the model).

import { magnitude, vswr, db, nearestPointByFrequency, type SweepPoint } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export const F0 = 13.56e6;

export interface Dip { freqHz: number; gammaMin: number; index: number; }

/** The min-|Γ| point of the sweep — the loop's closest approach to the Smith centre. */
export function dipOf(sweep: SweepPoint[]): Dip | null {
  if (!sweep.length) return null;
  let bi = 0, bg = Infinity;
  for (let i = 0; i < sweep.length; i++) {
    const g = magnitude(sweep[i].s11);
    if (g < bg) { bg = g; bi = i; }
  }
  return { freqHz: sweep[bi].frequency, gammaMin: bg, index: bi };
}

function pointAtF0(sweep: SweepPoint[]) { return nearestPointByFrequency(sweep, F0); }
function converged(sweep: SweepPoint[]): boolean {
  const p = pointAtF0(sweep);
  return !!p && (db(p.s11) < -20 || vswr(p.s11) < 1.2);
}

export interface ShapeOpts {
  maxIters?: number;
  freqTolHz?: number; // how close the dip must sit to 13.56 before we work on depth
  maxStep?: number; // damping: max % cap move per step
  depthGate?: number; // |Γ|_min target for the loop depth
  tuneHzPerPct?: number; // initial d(dip freq)/d(tune %), signed — refined by secant
  onStep?: (s: { iter: number; tune: number; load: number; dipHz: number; gammaMin: number; cost: number }) => void;
  shouldStop?: () => boolean;
}

export interface ShapeResult { tune: number; load: number; converged: boolean; iters: number; }
export type ShapeProbe = (tune: number, load: number) => SweepPoint[] | Promise<SweepPoint[]>;

export async function shapeTune(probe: ShapeProbe, start: { tune: number; load: number }, opts: ShapeOpts): Promise<ShapeResult> {
  const maxIters = opts.maxIters ?? 40;
  const freqTol = opts.freqTolHz ?? 8000; // ~1.5 points at 5 kHz/pt
  const maxStep = opts.maxStep ?? 6;
  const depthGate = opts.depthGate ?? 0.02;
  let gTF = opts.tuneHzPerPct ?? 135000; // Hz per % tune (model: ~F0·1%); sign says which way tune moves the dip
  let loadDir: 1 | -1 = 1;

  let tune = clampCap(Math.round(start.tune));
  let load = clampCap(Math.round(start.load));
  let lastMove: "tune" | "load" | null = null;
  let beforeDip: Dip | null = null;
  let beforeTune = tune;
  let beforeLoad = load;

  for (let iter = 1; iter <= maxIters; iter++) {
    if (opts.shouldStop?.()) return { tune, load, converged: false, iters: iter };
    const sweep = await probe(tune, load);
    const dip = dipOf(sweep);
    if (!dip) return { tune, load, converged: false, iters: iter };
    const cost = magnitude(pointAtF0(sweep)!.s11);
    opts.onStep?.({ iter, tune, load, dipHz: dip.freqHz, gammaMin: dip.gammaMin, cost });
    if (converged(sweep)) return { tune, load, converged: true, iters: iter };

    // learn from the previous move
    if (lastMove === "tune" && beforeDip && tune !== beforeTune) {
      const g = (dip.freqHz - beforeDip.freqHz) / (tune - beforeTune);
      if (Math.abs(g) > 1000) gTF = g;
    } else if (lastMove === "load" && beforeDip && load !== beforeLoad && dip.gammaMin > beforeDip.gammaMin + 1e-3) {
      loadDir = (-loadDir) as 1 | -1;
    }

    // Step 1 — TUNE: slide the dip's frequency onto 13.56.
    if (Math.abs(dip.freqHz - F0) > freqTol) {
      let step = Math.round((F0 - dip.freqHz) / gTF);
      step = Math.max(-maxStep, Math.min(maxStep, step));
      if (step === 0) step = (F0 - dip.freqHz) / gTF > 0 ? 1 : -1;
      const nt = clampCap(tune + step);
      if (nt !== tune) { beforeDip = dip; beforeTune = tune; lastMove = "tune"; tune = nt; continue; }
    }

    // Step 2 — LOAD: open the loop until the dip reaches 50 Ω (depth → 0).
    if (dip.gammaMin > depthGate) {
      const nl = clampCap(load + loadDir);
      if (nl !== load) { beforeDip = dip; beforeLoad = load; lastMove = "load"; load = nl; continue; }
    }

    return { tune, load, converged: converged(sweep), iters: iter }; // both axes stuck
  }
  return { tune, load, converged: converged(await probe(tune, load)), iters: maxIters };
}
