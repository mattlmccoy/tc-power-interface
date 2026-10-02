// In-run drift & travel tracker. Uses only what THIS run has measured: delivered energy and the cap
// positions the operator actually found the match at. On 218-2core (2026-10-02 FULL_SWEEP) the match
// moved one way only — Tune DOWN ~7 % over 8.2 Wh — driven by heating (accumulated energy), not by the
// instantaneous power: single 40/50 W runs (~2 Wh) never needed a retune. So: how fast is it moving
// per Wh, and how much cap travel is left before the AIT runs out? Advisory only.

import type { TelSample } from "./track.ts";

export interface DriftHold {
  tune: number;
  load: number;
  eStartWh: number; // delivered energy when the match was found here
  eEndWh: number;
  tStart: number;
  tLast: number;
}

interface Run { tune: number; load: number; tStart: number; eStart: number }

export interface DriftState {
  eWh: number;
  lastT: number | null;
  offSince: number | null;
  run: Run | null;
  holds: DriftHold[];
}

export const DRIFT_DEFAULTS = {
  minFwdW: 10,
  matchedFrac: 0.01, // reflected ≤ 1 % of forward = the operator has the match here
  holdMs: 3000,
  deadband: 0.15, // percent; absorbs the ±0.1 % readback flicker
  maxDtMs: 5000, // telemetry gaps longer than this don't count as delivered energy
  resetOffMs: 5 * 60_000, // RF off this long: the network has cooled, start a new history
  windowWh: 3, // the rate is fitted over matched positions found in the last 3 Wh
  minRate: 0.1, // %/Wh; slower than this is not called a drift
};
export type DriftConfig = typeof DRIFT_DEFAULTS;

export const emptyDrift = (): DriftState => ({ eWh: 0, lastT: null, offSince: null, run: null, holds: [] });

export function driftSample(st: DriftState, s: TelSample, cfg: DriftConfig = DRIFT_DEFAULTS): DriftState {
  if (!s.rfOn) {
    const offSince = st.offSince ?? s.tMs;
    if (s.tMs - offSince > cfg.resetOffMs) return { ...emptyDrift(), lastT: s.tMs, offSince };
    return { ...st, lastT: s.tMs, offSince, run: null };
  }
  const dt = st.lastT == null ? 0 : Math.min(Math.max(0, s.tMs - st.lastT), cfg.maxDtMs);
  const eWh = st.eWh + (s.fwd * dt) / 3.6e6;
  const base = { ...st, eWh, lastT: s.tMs, offSince: null };
  const matched = s.fwd >= cfg.minFwdW && s.rev <= cfg.matchedFrac * s.fwd && s.tune != null && s.load != null;
  if (!matched) return { ...base, run: null };
  const tune = s.tune as number, load = s.load as number;
  const near = (a: number, b: number) => Math.abs(a - b) <= cfg.deadband + 1e-9;
  const run: Run = st.run && near(tune, st.run.tune) && near(load, st.run.load) ? st.run : { tune, load, tStart: s.tMs, eStart: eWh };
  if (s.tMs - run.tStart < cfg.holdMs) return { ...base, run };
  const holds = [...st.holds];
  const last = holds[holds.length - 1];
  if (last && near(last.tune, run.tune) && near(last.load, run.load)) {
    holds[holds.length - 1] = { ...last, eEndWh: eWh, tLast: s.tMs }; // same position again: extend it
  } else {
    holds.push({ tune: run.tune, load: run.load, eStartWh: run.eStart, eEndWh: eWh, tStart: run.tStart, tLast: s.tMs });
  }
  return { ...base, run, holds };
}

export interface DriftSummary {
  eWh: number;
  holds: number;
  tuneRate: number | null; // %/Wh over the recent matched positions; null = not enough retunes yet
  loadRate: number | null;
  tuneLeft: number | null; // % of travel left above 0 %
  loadLeft: number | null;
  whToTuneFloor: number | null; // at the current Tune rate (only when drifting down)
  minToTuneFloor: number | null; // at the present forward power
  whToLoadFloor: number | null;
  minToLoadFloor: number | null;
}

function slope(xs: number[], ys: number[]): number {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  return sxx > 0 ? sxy / sxx : 0;
}

export function driftSummary(
  st: DriftState,
  current: { tune: number | null; load: number | null; fwd: number },
  cfg: DriftConfig = DRIFT_DEFAULTS,
): DriftSummary {
  const recent = st.holds.filter((h) => h.eEndWh >= st.eWh - cfg.windowWh);
  const moved = recent.length >= 2 && (
    Math.max(...recent.map((h) => h.tune)) - Math.min(...recent.map((h) => h.tune)) >= 0.5
    || Math.max(...recent.map((h) => h.load)) - Math.min(...recent.map((h) => h.load)) >= 0.5);
  const xs = recent.map((h) => h.eStartWh);
  const tuneRate = moved ? slope(xs, recent.map((h) => h.tune)) : null;
  const loadRate = moved ? slope(xs, recent.map((h) => h.load)) : null;
  const tuneLeft = current.tune, loadLeft = current.load;
  const toFloor = (rate: number | null, left: number | null) => (rate != null && rate < -cfg.minRate && left != null ? left / -rate : null);
  const minutes = (wh: number | null) => (wh != null && current.fwd >= 1 ? (wh * 60) / current.fwd : null);
  const whToTuneFloor = toFloor(tuneRate, tuneLeft), whToLoadFloor = toFloor(loadRate, loadLeft);
  return {
    eWh: st.eWh, holds: st.holds.length, tuneRate, loadRate, tuneLeft, loadLeft,
    whToTuneFloor, minToTuneFloor: minutes(whToTuneFloor), whToLoadFloor, minToLoadFloor: minutes(whToLoadFloor),
  };
}
