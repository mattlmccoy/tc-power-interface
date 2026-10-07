// Pure helpers for the live cockpit, computed from the history buffer (lib/cockpit/history.ts) and
// the latest telemetry. No DOM/React — unit-tested in live.test.ts.

import { mmss } from "./format.ts";
import type { CockpitSample } from "./history.ts";
import type { Shadow } from "./shadowText.ts";

const NS = 1e9;
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** Core-watch warn thresholds. Provisional until set from run data (Task 22 moves them to Settings). */
export const WATCH_DEFAULTS = { tempC: 45, ratePerMin: 3, provisional: true } as const;
export const MAX_WATCH = 4; // backend api/app.py WatchBody max_length

/**
 * Part temperature rate in °C/min: the first and last finite readings in the last `windowS` of the
 * buffer. Null until they span at least half the window (too short a baseline is noise), and an
 * unknown reading is skipped, never read as 0.
 */
export function partRate(buf: CockpitSample[], windowS = 60): number | null {
  if (!buf.length) return null;
  const from = buf[buf.length - 1].ns - windowS * NS;
  let first: CockpitSample | null = null;
  let last: CockpitSample | null = null;
  for (const s of buf) {
    if (s.ns < from || !fin(s.part)) continue;
    if (!first) first = s;
    last = s;
  }
  if (!first || !last) return null;
  const span = (last.ns - first.ns) / NS;
  if (span < windowS / 2) return null;
  return ((last.part! - first.part!) / span) * 60;
}

export interface RunStats {
  elapsedS: number;
  /** Forward energy (not absorbed), Wh, over the samples this page saw. */
  energyWh: number;
  /** What the numbers cover: the page saw the recording start, or it opened mid-run. */
  since: "recording start" | "page open";
}

/** Longer than this between two samples = the link dropped; that interval adds no energy. */
const MAX_GAP_S = 5;

/**
 * Elapsed time and forward energy of the CURRENT run, from its samples in the buffer. Null when not
 * recording or nothing is known yet. `since` says what that covers: "recording start" only when the
 * buffer holds a sample from before the run (so its first run sample is the start).
 */
export function runStats(buf: CockpitSample[], run: string | null): RunStats | null {
  if (run === null) return null;
  const firstIdx = buf.findIndex((s) => s.run === run);
  if (firstIdx < 0) return null;
  const rs = buf.filter((s) => s.run === run);
  let j = 0;
  for (let i = 1; i < rs.length; i++) {
    const dt = (rs[i].ns - rs[i - 1].ns) / NS;
    if (dt > 0 && dt <= MAX_GAP_S && fin(rs[i].fwd) && fin(rs[i - 1].fwd)) j += ((rs[i].fwd + rs[i - 1].fwd) / 2) * dt;
  }
  return {
    elapsedS: (rs[rs.length - 1].ns - rs[0].ns) / NS,
    energyWh: j / 3600,
    since: firstIdx > 0 ? "recording start" : "page open",
  };
}

export interface MatchStatus {
  chip: string;
  text: string;
  tone: "ok" | "warn" | "muted";
}

/**
 * The Match card's chip and one-line status from the live telemetry: ≤ 0.25 % reflected "Matched.
 * Hold.", < 1 % "Close", else "retune by hand". RF off, no telemetry, or forward too low to give a
 * meaningful % are their own muted states, never "matched".
 */
export function matchStatus(t: { rf_on: boolean; forward_w: number; reverse_w: number } | null): MatchStatus {
  if (!t) return { chip: "—", text: "No telemetry.", tone: "muted" };
  if (!t.rf_on) return { chip: "RF off", text: "RF off", tone: "muted" };
  if (!fin(t.forward_w) || !fin(t.reverse_w) || t.forward_w < 1)
    return { chip: "—", text: "Forward under 1 W: no reflected % yet.", tone: "muted" };
  const pct = (100 * t.reverse_w) / t.forward_w;
  const chip = `${pct.toFixed(1)} % reflected`;
  if (pct <= 0.25) return { chip, text: "Matched. Hold.", tone: "ok" };
  if (pct < 1) return { chip, text: "Close: reflected below 1 %.", tone: "ok" };
  return { chip, text: `Reflected ${pct.toFixed(1)} % — retune by hand.`, tone: "warn" };
}

const RETUNE_MIN_PCT = 0.5; // same rule as replay.ts runEvents

/**
 * Timestamps (ns) of retunes: Tune or Load moved ≥ 0.5 % from the last retune while RF is on. The
 * reference is reset at every RF-on edge (hand-tuning with RF off is not a retune), and an unknown
 * reading never fires or resets anything. Mirrors `runEvents` in replay.ts so live and replay agree.
 */
export function retuneNs(buf: CockpitSample[]): number[] {
  const out: number[] = [];
  let rf = false;
  let refT: number | null = null;
  let refL: number | null = null;
  for (const s of buf) {
    if (s.rf !== rf) {
      rf = s.rf;
      if (rf) { refT = s.tune; refL = s.load; }
    }
    if (!rf) continue;
    if (refT === null) refT = s.tune;
    if (refL === null) refL = s.load;
    const dT = fin(s.tune) && fin(refT) ? Math.abs(s.tune - refT) : 0;
    const dL = fin(s.load) && fin(refL) ? Math.abs(s.load - refL) : 0;
    if (dT >= RETUNE_MIN_PCT || dL >= RETUNE_MIN_PCT) {
      out.push(s.ns);
      refT = s.tune ?? refT;
      refL = s.load ?? refL;
    }
  }
  return out;
}

/** The watched-ROI list after a checkbox change: never the control ROI, never more than 4, no repeats. */
export function toggleWatch(current: string[], name: string, on: boolean, controlRoi: string | null): string[] {
  if (!on) return current.filter((n) => n !== name);
  if (name === controlRoi || current.includes(name) || current.length >= MAX_WATCH) return current;
  return [...current, name];
}

/**
 * The Target card's time-to-target line. Only to-temperature mode has one. The backend sends `ttt_s`
 * null when the part temperature is unknown (then `plateau_c` is null too) or the target is out of
 * reach at the current power (control/cockpit.py `_shadow_block`); those are said, not blanked.
 */
export function tttText(mode: string, s: Shadow | undefined, targetC: number): string {
  if (mode !== "target") return "Set in To-temperature mode.";
  if (!s || !s.valid) return "No estimate yet.";
  if (fin(s.ttt_s)) return `≈ ${mmss(s.ttt_s)} to target at your power`;
  if (!fin(s.plateau_c)) return "Waiting for part temperature.";
  if (fin(targetC) && s.plateau_c < targetC)
    return `Won't reach it at your power (levels off ≈ ${Math.round(s.plateau_c)} °C).`;
  return "Time to target unknown.";
}
