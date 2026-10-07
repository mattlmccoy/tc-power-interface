/** Pure display logic for the Sense loop panel. The panel only renders what these return.

Honesty rule: a reading taken with RF off, or one the backend marked invalid, is a fit to noise
(or to a clipped / mis-scaled waveform). Its numbers are never rendered as measurements. */

import { flagLabel, levelRows } from "./scope.ts";
import type { ScopeReading, ScopeStatus } from "./scope.ts";

const DASH = "—";
type Rec = Record<string, unknown>;

const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

/** The latest reading only when it is live (connected, present, not stale). */
function liveReading(st: ScopeStatus | undefined): ScopeReading | null {
  if (!st || st.stale || !st.status.connected || !st.latest) return null;
  return st.latest;
}

// ---- status pill -------------------------------------------------------------------------
export type PillKind = "live" | "stalled" | "nodata" | "error";
export interface Pill { kind: PillKind; cls: "connected" | "warn" | "disconnected" | "fault"; text: string; detail: string | null }

export function scopePill(st: ScopeStatus | undefined): Pill {
  if (st?.status.error) return { kind: "error", cls: "fault", text: "error", detail: st.status.error };
  if (st?.stale) return { kind: "stalled", cls: "warn", text: "stalled", detail: null };
  if (liveReading(st)) {
    const hz = st?.status.rate_hz;
    return { kind: "live", cls: "connected", text: hz ? `live · ${hz.toFixed(1)} Hz` : "live", detail: null };
  }
  return { kind: "nodata", cls: "disconnected", text: "no data", detail: null };
}

// ---- config summary / settings drawer ----------------------------------------------------
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function configSummary(settings: Rec | undefined): string {
  if (!settings) return "";
  const geo = (settings.geometry ?? {}) as Rec;
  const parts = [
    String(settings.core_label ?? ""),
    plural(num(geo.turns, 1), "turn"),
    plural(num(geo.cores_linked, 1), "core"),
    `probe ${num(settings.probe_attn, 1)}×`,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function autoOpenSettings(st: ScopeStatus | undefined): boolean {
  return !st || !String(st.settings?.resource ?? "") || !!st.status.error;
}

// ---- meters ------------------------------------------------------------------------------
export type Zone = "live" | "warn" | "trip";
export interface Meter { frac: number | null; zone: Zone; marks: { frac: number; cls: "warn" | "err" }[]; legend: string }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function limits(st: ScopeStatus | undefined) {
  const l = (st?.settings?.limits ?? {}) as Rec;
  return { warn: num(l.probe_warn_v, 65), hard: num(l.probe_hard_v, 70), stop: num(l.flux_stop_mt, 6) };
}

function vMeter(v: number | null, st: ScopeStatus | undefined): Meter {
  const { warn, hard } = limits(st);
  const ceil = hard * 1.1;
  const zone: Zone = v == null ? "live" : v >= hard ? "trip" : v >= warn ? "warn" : "live";
  return {
    frac: v == null ? null : clamp01(v / ceil), zone,
    marks: [{ frac: warn / ceil, cls: "warn" }, { frac: hard / ceil, cls: "err" }],
    legend: `probe ${warn} / ${hard} V`,
  };
}

/** The backend defines only a flux STOP limit, so B has two zones (live / trip). */
function bMeter(b: number | null, st: ScopeStatus | undefined): Meter {
  const { stop } = limits(st);
  const ceil = stop * 1.33;
  return {
    frac: b == null ? null : clamp01(b / ceil), zone: b != null && b >= stop ? "trip" : "live",
    marks: [{ frac: stop / ceil, cls: "err" }], legend: `stop ${stop.toFixed(1)} mT`,
  };
}

// ---- hero model --------------------------------------------------------------------------
export type Blank = "RF off" | "invalid" | null;
export interface Hero {
  blank: Blank;
  vrms: { value: string | null; note: string | null };
  b: { value: string | null };
  f0: string; pkpk: string; h2: string; h3: string; resid: string;
  vMeter: Meter; bMeter: Meter;
}

export function blankReason(r: ScopeReading): Blank {
  if (r.level_state === "rf_off") return "RF off";
  if (!r.valid) return "invalid";
  return null;
}

export function heroModel(st: ScopeStatus | undefined): Hero {
  const r = liveReading(st);
  const dashes = { f0: DASH, pkpk: DASH, h2: DASH, h3: DASH, resid: DASH };
  if (!r) {
    return { blank: null, vrms: { value: null, note: null }, b: { value: null }, ...dashes,
      vMeter: vMeter(null, st), bMeter: bMeter(null, st) };
  }
  const blank = blankReason(r);
  if (blank) {
    const note = blank === "invalid" ? "invalid reading"
      : r.vrms_v == null ? null : `noise floor ${r.vrms_v.toFixed(1)} V`;
    return { blank, vrms: { value: null, note }, b: { value: DASH }, ...dashes,
      vMeter: vMeter(null, st), bMeter: bMeter(null, st) };
  }
  const f = (x: number | null, d: number, unit = "") => (x == null ? DASH : `${x.toFixed(d)}${unit}`);
  return {
    blank: null,
    vrms: { value: r.vrms_v == null ? null : r.vrms_v.toFixed(1), note: null },
    b: { value: r.b_pk_mt == null ? null : r.b_pk_mt.toFixed(2) },
    f0: r.f0_hz == null ? DASH : (r.f0_hz / 1e6).toFixed(3),
    pkpk: `${(r.vmax_v - r.vmin_v).toFixed(0)} V`,
    h2: f(r.h2_pct, 2, " %"), h3: f(r.h3_pct, 2, " %"), resid: f(r.resid_v, 2, " V"),
    vMeter: vMeter(r.vrms_v, st), bMeter: bMeter(r.b_pk_mt, st),
  };
}

// ---- level card --------------------------------------------------------------------------
const STATE_WORD: Record<string, string> = {
  assigned: "assigned", settling: "settling", off_setpoint: "off setpoint",
  no_setpoint: "no setpoint", rf_off: "RF off",
};
export const stateWord = (s: string) => STATE_WORD[s] ?? s.replaceAll("_", " ");

export interface LevelCard { big: string; assigned: boolean; sub: string | null; vps: string | null }

export function levelCard(st: ScopeStatus | undefined): LevelCard {
  const r = liveReading(st);
  if (!r) return { big: DASH, assigned: false, sub: null, vps: null };
  const assigned = r.level_state === "assigned" && r.level_w != null && r.level_w > 0;
  const word = stateWord(r.level_state);
  const sub = r.forward_w == null ? word : `${word} · fwd ${r.forward_w.toFixed(1)} W`;
  const vps = assigned && r.valid && r.vrms_v != null
    ? `${(r.vrms_v / Math.sqrt(r.level_w as number)).toFixed(2)} V/√W` : null;
  return { big: assigned ? `${r.level_w} W` : word, assigned, sub, vps };
}

/** The level whose table row is highlighted: the live, valid, assigned level. */
export function activeLevel(st: ScopeStatus | undefined): number | null {
  const r = liveReading(st);
  return r && r.valid && r.level_state === "assigned" ? r.level_w : null;
}

// ---- trend -------------------------------------------------------------------------------
export interface Sample { t_ns: number; v: number | null; b: number | null }
export interface TrendPoint { t: number; v: number | null; b: number | null }

/** Append the reading (dedupe by host_timestamp_ns), blanked when RF is off or it is invalid. */
export function appendSample(buf: Sample[], r: ScopeReading | null | undefined, cap: number): Sample[] {
  if (!r || buf.at(-1)?.t_ns === r.host_timestamp_ns) return buf;
  const blank = blankReason(r) !== null;
  const s = { t_ns: r.host_timestamp_ns, v: blank ? null : r.vrms_v, b: blank ? null : r.b_pk_mt };
  const out = [...buf, s];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Points in the last windowS seconds (t relative to now, s); a null point breaks the line at any
 * gap longer than gapS (stall / disconnect) so the trace never bridges missing data. */
export function trendSeries(buf: Sample[], nowNs: number, windowS: number, gapS: number): TrendPoint[] {
  const out: TrendPoint[] = [];
  let prev: number | null = null;
  for (const s of buf) {
    const t = (s.t_ns - nowNs) / 1e9;
    if (t < -windowS) continue;
    if (prev != null && t - prev > gapS) out.push({ t: (t + prev) / 2, v: null, b: null });
    out.push({ t, v: s.v, b: s.b });
    prev = t;
  }
  return out;
}

// ---- level table -------------------------------------------------------------------------
export interface LevelTableRow { key: number; level: string; n: string; vrms: string; vps: string; b: string; h2: string; active: boolean }

export function levelTable(readings: ScopeReading[], active: number | null): LevelTableRow[] {
  return levelRows(readings).map((r) => ({
    key: r.level_w, level: `${r.level_w} W`, n: String(r.n), vrms: r.vrms_median_v.toFixed(1),
    vps: r.v_per_sqrtw.toFixed(2), b: r.b_median_mt == null ? DASH : r.b_median_mt.toFixed(2),
    h2: r.h2_median_pct == null ? DASH : r.h2_median_pct.toFixed(2), active: r.level_w === active,
  }));
}

// ---- flags / downloads -------------------------------------------------------------------
export function flagBanners(flags: string | undefined) {
  const out = (flags ?? "").split(";").filter(Boolean).map(flagLabel);
  return [...out.filter((f) => f.severity === "danger"), ...out.filter((f) => f.severity !== "danger")];
}

export function recordingDownloads(files: string[] | null): { scope: boolean } {
  return { scope: !!files?.includes("scope.csv") };
}
