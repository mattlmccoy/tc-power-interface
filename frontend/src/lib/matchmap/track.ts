// In-run readings for the match aid. Turns the telemetry stream into "held position" readings: a T/L
// readback held still (within a deadband that absorbs the ±0.1 % flicker and small creep) for long
// enough, with RF on, gives |Γ| = sqrt(reflected / forward) at that position. Reflected power has
// 0.1 W resolution, so each reading carries the interval [gLo, gHi] the true |Γ| can be in (0.0 W
// means "below 0.05 W", not zero). Readings expire: the load drifts fast (run 20260928_193906:
// 0.1 → 3.6 W in ~20 s at fixed caps), so old readings describe a match that has since moved.

export interface TelSample {
  tMs: number;
  rfOn: boolean;
  fwd: number;
  rev: number;
  tune?: number | null;
  load?: number | null;
}

export interface Reading {
  tune: number;
  load: number;
  fwd: number;
  rev: number;
  g: number;
  gLo: number;
  gHi: number;
  tFirst: number; // when the hold started
  tLast: number; // latest sample folded in
}

interface Run { tune: number; load: number; tStart: number }

export interface TrackState { run: Run | null; readings: Reading[] }

export const TRACK_DEFAULTS = {
  minFwdW: 10, // below this, reflected/forward is too coarse to mean anything
  holdMs: 1800, // ~3 telemetry samples; screens out the in-motion readback
  deadband: 0.15, // percent
  maxAgeMs: 30000,
  maxReadings: 6,
  revResW: 0.1,
};
export type TrackConfig = typeof TRACK_DEFAULTS;

export const emptyTrack = (): TrackState => ({ run: null, readings: [] });

function reading(run: Run, s: TelSample, cfg: TrackConfig): Reading {
  const half = cfg.revResW / 2;
  return {
    tune: run.tune, load: run.load, fwd: s.fwd, rev: s.rev,
    g: Math.sqrt(Math.max(0, s.rev) / s.fwd),
    gLo: Math.sqrt(Math.max(0, s.rev - half) / s.fwd),
    gHi: Math.sqrt((Math.max(0, s.rev) + half) / s.fwd),
    tFirst: run.tStart, tLast: s.tMs,
  };
}

export function trackSample(st: TrackState, s: TelSample, cfg: TrackConfig = TRACK_DEFAULTS): TrackState {
  let readings = st.readings.filter((r) => r.tLast >= s.tMs - cfg.maxAgeMs);
  const valid = s.rfOn && s.fwd >= cfg.minFwdW && s.tune != null && s.load != null
    && Number.isFinite(s.tune) && Number.isFinite(s.load);
  if (!valid) return { run: null, readings };
  const tune = s.tune as number, load = s.load as number;
  const within = (a: number, b: number) => Math.abs(a - b) <= cfg.deadband + 1e-9;
  const run: Run = st.run && within(tune, st.run.tune) && within(load, st.run.load)
    ? st.run
    : { tune, load, tStart: s.tMs };
  if (s.tMs - run.tStart >= cfg.holdMs) {
    const r = reading(run, s, cfg);
    const i = readings.findIndex((x) => x.tFirst === run.tStart);
    readings = i >= 0 ? readings.map((x, k) => (k === i ? r : x)) : [...readings, r];
    if (readings.length > cfg.maxReadings) readings = readings.slice(readings.length - cfg.maxReadings);
  }
  return { run, readings };
}
