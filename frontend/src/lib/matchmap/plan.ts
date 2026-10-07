// Capture plan for the cold match map: the ordered cap moves and record points for a grid around the
// current match. Commands are whole percent (the generator's resolution), and every recorded point is
// approached FROM BELOW on both caps: the readback can't see backlash, and the 09-03 study measured
// 3.2 Ohm between approach directions at the same labelled position. Ends by returning to the start
// (also from below) and recording it again as a drift check.

import { clampCap } from "../instrument.ts";

export type Step =
  | { kind: "move"; axis: "tune" | "load"; value: number }
  | { kind: "record"; label: string; tune: number; load: number; repeat: boolean };

/** Symmetric offsets: 1 % steps out to ±fine, then `step` % steps, always ending exactly at ±span. */
export function gridOffsets(span: number, fine: number, step: number): number[] {
  const out = new Set<number>([0]);
  for (let o = 1; o <= Math.min(fine, span); o++) { out.add(o); out.add(-o); }
  for (let o = Math.max(fine, 0) + step; o < span; o += step) { out.add(o); out.add(-o); }
  out.add(span); out.add(-span);
  return [...out].sort((x, y) => x - y);
}

/** Quick grid levels: ends, halves and centre of ±span (5 levels). Used for LOAD (broad, ~4.5 Ohm per %).
 *  For Tune it was too coarse: 3 % steps gave an 8.3 Ohm held-out map on 2026-10-06 (see quickTuneOffsets).
 *  The held-out error shown after every capture says whether a quick grid was enough. */
export function quickOffsets(span: number): number[] {
  const h = Math.round(span / 2);
  return [...new Set([-span, -h, 0, h, span])].sort((x, y) => x - y);
}

/** Quick grid Tune levels: 1 % steps next to the match plus halves and ends. Tune moves Z ~17 Ohm per %
 *  on 218-2core, and a Quick map with 3 % Tune steps fitted with 8.3 Ohm held-out error (2026-10-06)
 *  against 1-2.3 Ohm for 1 %-step grids. 7 levels × 5 Load levels = 35 points. */
export function quickTuneOffsets(span: number): number[] {
  return [...new Set([...quickOffsets(span), ...(span >= 1 ? [-1, 1] : [])])].sort((x, y) => x - y);
}

/** Default capture grid: wide and SYMMETRIC. The network is still being changed between runs, so the
 *  grid must not lean the way one run drifted (2026-10-02 went Tune −7 %, but that is one network on one
 *  day). Tune is sharp (~17 Ohm per % on 218-2core) so it gets 1 % steps near the match; Load is broad
 *  (~4.5 Ohm per %) so 2 % steps. 63 points ≈ 5 min; the VNA view can narrow or widen the spans. */
export const DEFAULT_TUNE_SPAN = 6;
export const DEFAULT_LOAD_SPAN = 6;
export const tuneOffsets = (span: number) => gridOffsets(span, 2, 2);
export const loadOffsets = (span: number) => gridOffsets(span, 0, 2);
export const DEFAULT_TUNE_OFFSETS = tuneOffsets(DEFAULT_TUNE_SPAN);
export const DEFAULT_LOAD_OFFSETS = loadOffsets(DEFAULT_LOAD_SPAN);

const levels = (centre: number, offsets: number[]) =>
  [...new Set(offsets.map((o) => clampCap(centre + o)))].sort((a, b) => a - b);

export function capturePlan(tune0: number, load0: number, tuneOffsets: number[], loadOffsets: number[]): Step[] {
  const tc = clampCap(tune0), lc = clampCap(load0);
  const steps: Step[] = [];
  const pos: Record<"tune" | "load", number | null> = { tune: null, load: null };
  const upward: Record<"tune" | "load", boolean> = { tune: false, load: false }; // last arrival was upward
  // Finish on `target` going up: step below first unless already below it, or already sitting on it
  // after an upward arrival. (At 0 there is no below.)
  const moveUp = (axis: "tune" | "load", target: number) => {
    const cur = pos[axis];
    if (cur === target && upward[axis]) return;
    if (cur !== null && cur < target) {
      steps.push({ kind: "move", axis, value: target });
      upward[axis] = true;
    } else {
      const pre = Math.max(0, target - 1);
      if (pre !== cur) steps.push({ kind: "move", axis, value: pre });
      if (pre !== target) steps.push({ kind: "move", axis, value: target });
      upward[axis] = pre < target;
    }
    pos[axis] = target;
  };
  for (const t of levels(tc, tuneOffsets)) {
    moveUp("tune", t);
    for (const l of levels(lc, loadOffsets)) {
      moveUp("load", l);
      steps.push({ kind: "record", label: `T${t} L${l}`, tune: t, load: l, repeat: false });
    }
  }
  moveUp("tune", tc);
  moveUp("load", lc);
  steps.push({ kind: "record", label: `T${tc} L${lc} (repeat)`, tune: tc, load: lc, repeat: true });
  return steps;
}
