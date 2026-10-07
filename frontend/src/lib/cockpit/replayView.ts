// Pure helpers for the Runs (replay) view: the cursor, the values in force at it, the timeline
// samples built from a recording and its shadow re-run, and the re-run's request key. No DOM/React.

import type { ReplayShadowPoint } from "../api.ts";
import type { CockpitSample } from "./history.ts";
import type { ReplayRow } from "./replay.ts";
import { SHOW_CONFIDENCE, type Shadow } from "./shadowText.ts";

/** A shadow point farther than this from a row is not "the same moment" (replay.ts MATCH_TOLERANCE_S). */
const JOIN_S = 2;

/** Index of the last time at or before `t` in an ascending list; -1 before the first, when empty, or for a non-finite t. */
export function cursorIndex(times: number[], t: number): number {
  if (!Number.isFinite(t) || !times.length || t < times[0]) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The recorded row and the shadow point in force at cursor time `t` (seconds from the run start). */
export function valuesAt(
  rows: ReplayRow[],
  pts: ReplayShadowPoint[],
  t: number,
): { row: ReplayRow | null; shadow: ReplayShadowPoint | null } {
  const i = cursorIndex(rows.map((r) => r.t_s), t);
  const j = cursorIndex(pts.map((p) => p.t_s), t);
  return { row: i < 0 ? null : rows[i], shadow: j < 0 ? null : pts[j] };
}

/**
 * Timeline samples for a recording. With a shadow re-run, `part` is the CHOSEN ROI's temperature
 * (the re-run's temp_c, joined to the nearest point within 2 s, else unknown) and `suggest` is the
 * suggestion at ≥ 30 % confidence. Without one, the recorded control temperature is used and there
 * is no suggestion. A blank forward/reverse is NaN (a gap), never 0. `ns` counts from the run start.
 */
export function replaySamples(rows: ReplayRow[], pts: ReplayShadowPoint[] | null): CockpitSample[] {
  let j = 0;
  return rows.map((r) => {
    let p: ReplayShadowPoint | null = null;
    if (pts && pts.length) {
      while (j + 1 < pts.length && Math.abs(pts[j + 1].t_s - r.t_s) <= Math.abs(pts[j].t_s - r.t_s)) j++;
      if (Math.abs(pts[j].t_s - r.t_s) <= JOIN_S) p = pts[j];
    }
    const part = pts ? (p?.temp_c ?? null) : r.part_temp_c;
    const suggest = p && p.confidence >= SHOW_CONFIDENCE ? p.suggest_w : null;
    return {
      ns: Math.round(r.t_s * 1e9),
      run: null,
      rf: r.rf_on,
      fwd: r.forward_w ?? Number.NaN,
      rev: r.reverse_w ?? Number.NaN,
      part,
      watch: {},
      suggest,
      tune: r.tune,
      load: r.load,
    };
  });
}

/** A replay point in the live `Shadow` shape, so the same shadow card renders it. The replay does
 *  not report ambient, settle time or time to target: those stay null. */
export function shadowAt(p: ReplayShadowPoint | null): Shadow | null {
  if (!p) return null;
  const valid = p.k_c_per_w != null && Number.isFinite(p.k_c_per_w) && p.tau_s != null && Number.isFinite(p.tau_s);
  return {
    valid,
    why: valid ? null : "no estimate yet at this point",
    k_c_per_w: p.k_c_per_w,
    tau_s: p.tau_s,
    confidence: p.confidence,
    t_amb_c: null,
    updates: 0,
    suggest_w: p.suggest_w,
    plateau_c: p.plateau_c,
    settle_s: null,
    ttt_s: null,
    show: valid && p.confidence >= SHOW_CONFIDENCE,
  };
}

/** Request key for a shadow re-run (debounce + stale-response guard); null = nothing to fetch. */
export function shadowKey(run: string | null, roi: string, target: number): string | null {
  if (!run || !roi || !Number.isFinite(target)) return null;
  return `${run}\u0000${roi}\u0000${target}`;
}
