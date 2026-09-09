// VNA auto-tune control law (pure). Objective: drive Γ at 13.56 MHz to the Smith centre
// (Z → 50 + j0). The NanoVNA gives the full complex S11 sweep, so the move is INFORMED, not blind
// perturb-and-observe: decompose with the measured tune-sharp / load-broad physics —
//   TUNE cap  = resonant-frequency knob → align the dip's frequency onto 13.56 MHz (X → 0)
//   LOAD cap  = coupling knob           → pull R(13.56) → 50
// One pure step decides ONE bounded cap move; the run loop (in the panel) iterates with real
// sweeps between steps and flips a sign if a step raises cost (see the spec + plan).

import {
  magnitude,
  vswr,
  impedance,
  nearestPointByFrequency,
  markerIndex,
  db,
  type SweepPoint,
} from "./rf.ts";
import { clampCap } from "../instrument.ts";

/** Operating frequency: 13.56 MHz. */
export const F0 = 13.56e6;

export interface TuneModel {
  /** Sign of d(dip frequency)/d(tune %). Seed; the run loop flips it if a step worsens cost. */
  tuneSign: 1 | -1;
  /** Sign of dR/d(load %). Seed; flipped by the run loop on a worsening step. */
  loadSign: 1 | -1;
  /** Whole-percent step for each tune move (caps command in 1% steps). */
  tuneStep: number;
  /** Whole-percent step for each load move. */
  loadStep: number;
  /** Max iterations the run loop will take before aborting. */
  maxIter: number;
}

export const DEFAULT_MODEL: TuneModel = {
  tuneSign: 1,
  loadSign: 1,
  tuneStep: 1,
  loadStep: 1,
  maxIter: 40,
};

export type VnaAction = "tune" | "load" | "done";

export interface VnaStep {
  nextTune: number;
  nextLoad: number;
  action: VnaAction;
  /** |Γ| at 13.56 MHz for this sweep (the objective; → 0). */
  cost: number;
  converged: boolean;
  /** Set when the step cannot proceed (e.g. empty sweep); caps are left unchanged. */
  abort?: string;
}

/** The sweep point nearest the operating frequency (the S11 we are matching). */
export function gammaAt(sweep: SweepPoint[]): SweepPoint | null {
  return nearestPointByFrequency(sweep, F0);
}

/** Convergence gate: return loss < −20 dB OR VSWR < 1.2 at 13.56 MHz. */
export function converged(point: SweepPoint): boolean {
  return db(point.s11) < -20 || vswr(point.s11) < 1.2;
}

/** Grid step (Hz) of a sweep; used as the tolerance for "dip is on F0". */
function gridStepHz(sweep: SweepPoint[]): number {
  if (sweep.length < 2) return 0;
  return Math.abs(sweep[1].frequency - sweep[0].frequency);
}

/** Decide the next single cap move toward the 13.56 MHz match. Pure; bounded; never commands RF. */
export function planVnaStep(
  sweep: SweepPoint[],
  caps: { tune: number; load: number },
  model: TuneModel,
): VnaStep {
  const point = gammaAt(sweep);
  if (!point) {
    return { nextTune: caps.tune, nextLoad: caps.load, action: "done", cost: 1, converged: false, abort: "empty sweep" };
  }
  const cost = magnitude(point.s11);
  if (converged(point)) {
    return { nextTune: caps.tune, nextLoad: caps.load, action: "done", cost, converged: true };
  }

  // Step 1 — TUNE: align the resonant dip onto F0.
  const dipHz = sweep[markerIndex(sweep)].frequency;
  if (Math.abs(dipHz - F0) > gridStepHz(sweep)) {
    const dir: 1 | -1 = dipHz < F0 ? model.tuneSign : (-model.tuneSign as 1 | -1);
    return { nextTune: clampCap(caps.tune + dir * model.tuneStep), nextLoad: caps.load, action: "tune", cost, converged: false };
  }

  // Step 2 — LOAD: pull R(F0) toward 50 Ω.
  const r = impedance(point.s11, 50).re;
  const dir: 1 | -1 = r < 50 ? model.loadSign : (-model.loadSign as 1 | -1);
  return { nextTune: caps.tune, nextLoad: clampCap(caps.load + dir * model.loadStep), action: "load", cost, converged: false };
}
