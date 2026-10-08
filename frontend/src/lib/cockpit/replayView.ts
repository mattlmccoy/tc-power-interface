// Pure helpers for the Runs (replay) view: the cursor, the values in force at it, the timeline
// samples built from a recording and its shadow re-run, and the re-run's request key. No DOM/React.

import type { RecordingEvent, ReplayShadowPoint } from "../api.ts";
import type { CockpitSample } from "./history.ts";
import type { ReplayEvent, ReplayRow } from "./replay.ts";
import { type Ambient, SHOW_CONFIDENCE, type Shadow } from "./shadowText.ts";

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

/** A replay point in the live `Shadow` shape, so the same shadow card renders it. `ambient` is the
 *  run's room-temperature decision (replay result, v0.19+); without it t_amb_c stays null. The
 *  replay does not report settle time or time to target: those stay null. */
export function shadowAt(p: ReplayShadowPoint | null, ambient?: Ambient | null): Shadow | null {
  if (!p) return null;
  const valid = p.k_c_per_w != null && Number.isFinite(p.k_c_per_w) && p.tau_s != null && Number.isFinite(p.tau_s);
  const amb = p.ambient !== undefined ? p.ambient : ambient; // the point's own decision wins
  const roomUnknown = amb != null && amb.t_c == null;
  return {
    valid,
    why: valid ? null : roomUnknown ? "room_unknown" : "no estimate yet at this point",
    ...(amb === undefined ? {} : { ambient: amb }),
    k_c_per_w: p.k_c_per_w,
    tau_s: p.tau_s,
    confidence: p.confidence,
    confidence_fit: p.confidence_fit ?? null,
    drift_pct: p.drift_pct ?? null,
    drifting: p.drifting === true,
    needed_w: p.needed_w ?? null,
    ceiling_w: p.ceiling_w ?? null,
    t_amb_c: amb?.t_c ?? null,
    updates: 0,
    suggest_w: p.suggest_w,
    plateau_c: p.plateau_c,
    settle_s: null,
    ttt_s: null,
    show: valid && p.confidence >= SHOW_CONFIDENCE && amb?.source !== "assumed", // unverified: muted
  };
}

/** Request key for a shadow re-run (debounce + stale-response guard); null = nothing to fetch. */
export function shadowKey(run: string | null, roi: string, target: number): string | null {
  if (!run || !roi || !Number.isFinite(target)) return null;
  return `${run}\u0000${roi}\u0000${target}`;
}

const pct = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x * 10) / 10} %` : "?");

/**
 * The recorder's events.json on the telemetry t_s axis (`ns0` = the first accepted row's timestamp).
 * Event stamps are time.time_ns() at the event (recorder.py:275), so they line up with rows only to
 * poll-interval accuracy; an event before the first row is placed at 0. No origin → nothing placed.
 */
export function recorderEvents(events: RecordingEvent[], ns0: bigint | null): ReplayEvent[] {
  if (ns0 === null || !Array.isArray(events)) return [];
  const out: ReplayEvent[] = [];
  for (const e of events as unknown[]) {
    // events.json is a file on disk: skip anything that is not {label: string, host_timestamp_ns: number}.
    if (typeof e !== "object" || e === null) continue;
    const { label, host_timestamp_ns: ns, data } = e as { label?: unknown; host_timestamp_ns?: unknown; data?: unknown };
    if (typeof label !== "string" || typeof ns !== "number" || !Number.isFinite(ns)) continue;
    const t = Number(BigInt(Math.round(ns)) - ns0) / 1e9;
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const text = label === "cap_command"
      ? `${typeof d.axis === "string" ? d.axis : "?"} cap → ${pct(d.requested)} (${typeof d.source === "string" ? d.source : "?"}, was ${pct(d.readback_before)})`
      : label.replace(/_/g, " ");
    out.push({ t_s: Math.max(0, t), text });
  }
  return out;
}

/** A recorder RF event and a row-derived edge within this many seconds are the same moment. */
const SAME_EDGE_S = 3;

/**
 * Derived (row) events and recorder events in time order. A derived RF edge is dropped only when a
 * recorder event of the SAME direction lies within 3 s: the recorder logs RF only for the operator's
 * /api/rf/enable|disable, so an RF-off from a reflected trip, a fault, a link loss or the timer has no
 * recorder event and must stay in the list.
 */
export function mergeEvents(derived: ReplayEvent[], recorder: ReplayEvent[]): ReplayEvent[] {
  const logged = (dir: "rf enabled" | "rf disabled", t: number) =>
    recorder.some((r) => r.text === dir && Math.abs(r.t_s - t) <= SAME_EDGE_S);
  const keep = derived.filter((e) =>
    e.text === "RF on" ? !logged("rf enabled", e.t_s) : e.text === "RF off" ? !logged("rf disabled", e.t_s) : true);
  return [...recorder, ...keep].sort((a, b) => a.t_s - b.t_s);
}

/** The replay's line about events.json: null when it loaded; a missing file (404: the run is still
 *  recording or did not stop cleanly) and a broken one are said, never silently empty. */
export function eventsStatus(state: "ok" | "missing" | "error", err = ""): string | null {
  if (state === "ok") return null;
  if (state === "missing") return "no events.json (run not stopped cleanly)";
  return `events.json: ${err}`;
}

/** Shadow numbers on screen (`shownKey`) no longer answer the current request (`currentKey`: null
 *  when the target is cleared), or the re-run for it failed: show them muted and labelled stale. */
export function shadowStale(shownKey: string | null, currentKey: string | null, failed: boolean): boolean {
  if (shownKey === null) return false;
  return failed || shownKey !== currentKey;
}
