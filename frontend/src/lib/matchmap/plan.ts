// Capture plan for the cold match map: the ordered cap moves and record points for a grid around the
// current match. Commands are whole percent (the generator's resolution), and every recorded point is
// approached FROM BELOW on both caps: the readback can't see backlash, and the 09-03 study measured
// 3.2 Ohm between approach directions at the same labelled position. Ends by returning to the start
// (also from below) and recording it again as a drift check.

import { clampCap } from "../instrument.ts";

export type Step =
  | { kind: "move"; axis: "tune" | "load"; value: number }
  | { kind: "record"; label: string; tune: number; load: number; repeat: boolean };

/** Tune is sharp (~17 Ohm per % on 218-2core_v2; 1.2 % = 20 dB), Load is broad, so Load is sampled in
 *  2 % steps over ±4 %: comparable Z change per step on both caps, and wide enough that an in-run drift
 *  of a couple of percent of Load stays inside the calibrated range (locate.ts flags it otherwise). */
export const DEFAULT_TUNE_OFFSETS = [-1, 0, 1];
export const DEFAULT_LOAD_OFFSETS = [-4, -2, 0, 2, 4];

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
