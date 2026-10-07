// One-line summaries for collapsed dashboard panels. Pure: each builder takes data the dashboard
// already has (the /api/status snapshot via the operator hook, or the match-aid hook) and returns
// segments ordered most-important-first, so CSS ellipsis drops the least important ones on a narrow
// column. Unknown is "—", never a fake 0.
import { fmtTemp, fmtWatts } from "./format.ts";
import { tempBar } from "./instrument.ts";
import type { AxisGuide, LocateResult } from "./matchmap/locate.ts";
import { flagLabel } from "./scope.ts";
import type { ScopeStatus } from "./scope.ts";
import { heroModel, levelCard, scopePill } from "./scopeView.ts";
import type { Zone as MeterZone } from "./scopeView.ts";
import type { MatchTunerStatus, RampStatus, Telemetry, TimerStatus } from "./telemetry.ts";

export type Tone = "live" | "warn" | "trip" | "rec" | "muted";
/** `label` renders muted, `text` is the value (strong unless toned). `color` overrides the tone. */
export interface Segment { label?: string; text: string; tone?: Tone; color?: string }

const DASH = "—";

/** The full line, for the tooltip and for tests. */
export const summaryText = (segs: Segment[]): string =>
  segs.map((s) => (s.label ? `${s.label} ${s.text}` : s.text)).join(" · ");

const zoneTone = (z: string): Tone | undefined => (z === "warn" || z === "trip" ? z : undefined);
const meterTone = (z: MeterZone): Tone | undefined => (z === "live" ? undefined : z);
const pct1 = (f: number) => `${(f * 100).toFixed(1)} %`;

// ---- Telemetry ----------------------------------------------------------------------------
/** `zone` = the operator's reflected-power zone (ok / warn / trip), as the Telemetry panel uses. */
export function telemetrySummary(t: Telemetry | null, zone: string): Segment[] {
  if (!t) return [{ label: "fwd", text: DASH }, { label: "refl", text: DASH }];
  // The backend writes reflected_fraction = 0 when forward is 0 (cxn.py), so only show it with power.
  const frac = t.forward_w > 0 && Number.isFinite(t.reflected_fraction) ? ` (${pct1(t.reflected_fraction)})` : "";
  return [
    { label: "fwd", text: fmtWatts(t.forward_w), tone: t.rf_on ? "live" : undefined },
    { label: "refl", text: `${fmtWatts(t.reverse_w)}${frac}`, tone: zoneTone(zone) },
  ];
}

// ---- RF power -----------------------------------------------------------------------------
export interface RfPowerInput {
  connected: boolean;
  armed: boolean;
  faulted: boolean;
  rfOn: boolean | null;
  /** controller.last_setpoint_w: the last setpoint the server applied (null until one is sent). */
  setpointW: number | null | undefined;
  ramp?: RampStatus;
}

export function rfPowerSummary(p: RfPowerInput): Segment[] {
  const set: Segment = { label: "set", text: p.setpointW == null ? DASH : `${p.setpointW} W` };
  if (!p.connected) return [set, { text: "disconnected", tone: "muted" }];
  const out: Segment[] = [
    set,
    p.rfOn ? { text: "RF on", tone: "live" } : { text: p.rfOn === false ? "RF off" : `RF ${DASH}`, tone: "muted" },
    p.faulted ? { text: "FAULT", tone: "trip" } : p.armed ? { text: "armed", tone: "warn" } : { text: "read-only", tone: "muted" },
  ];
  if (p.ramp?.running) out.push({ label: "ramp", text: `→ ${p.ramp.target_w} W` });
  return out;
}

// ---- Generator ----------------------------------------------------------------------------
export function generatorSummary(
  t: { temperature_c: number | null } | null | undefined,
  limits: { temperature_c_trip: number } | null | undefined,
): Segment[] {
  const temp = t?.temperature_c ?? null;
  const seg: Segment = { label: "internal temp", text: fmtTemp(temp) };
  if (temp != null && Number.isFinite(temp) && limits) seg.color = tempBar(temp, 25, limits.temperature_c_trip).color;
  return [seg];
}

// ---- Sense loop ---------------------------------------------------------------------------
/** Same honesty rules as the panel (scopeView): RF-off / invalid readings never show V or B. */
export function senseLoopSummary(st: ScopeStatus | undefined): Segment[] {
  const pill = scopePill(st);
  if (pill.kind === "error") return [{ text: "scope error", tone: "trip" }];
  if (pill.kind !== "live" || !st?.latest) return [{ text: "no data", tone: pill.kind === "stalled" ? "warn" : "muted" }];
  const r = st.latest;
  const flags = (r.flags ?? "").split(";").filter(Boolean)
    .map((f) => ({ f, sev: flagLabel(f).severity }))
    .sort((a, b) => Number(b.sev === "danger") - Number(a.sev === "danger"))
    .map(({ f, sev }): Segment => ({ text: `⚠ ${f.replaceAll("_", " ")}`, tone: sev === "danger" ? "trip" : "warn" }));
  const hero = heroModel(st);
  if (hero.blank === "invalid") return [...flags, { text: "invalid reading", tone: "warn" }];
  if (hero.blank === "RF off") {
    const noise: Segment[] = r.vrms_v == null ? [] : [{ label: "noise", text: `${r.vrms_v.toFixed(1)} V` }];
    return [...flags, { text: "RF off", tone: "muted" }, ...noise];
  }
  const lvl = levelCard(st);
  return [
    ...flags,
    { text: hero.vrms.value == null ? DASH : `${hero.vrms.value} V`, tone: meterTone(hero.vMeter.zone) },
    { text: hero.b.value == null ? DASH : `${hero.b.value} mT`, tone: meterTone(hero.bMeter.zone) },
    lvl.assigned ? { text: lvl.big } : { text: lvl.big, tone: "muted" },
  ];
}

// ---- Matching network ---------------------------------------------------------------------
export function matchNetSummary(t: Telemetry | null): Segment[] {
  const cap = (v: number | undefined) => (v == null || !Number.isFinite(v) ? DASH : `${v.toFixed(1)} %`);
  const out: Segment[] = [
    { label: "tune", text: cap(t?.tune_cap_percent) },
    { label: "load", text: cap(t?.load_cap_percent) },
  ];
  if (t?.manual_mode != null) out.push({ text: t.manual_mode ? "manual" : "auto" });
  return out;
}

// ---- Match aid ----------------------------------------------------------------------------
export interface MatchAidInput {
  map: unknown | null;
  result: LocateResult | null;
  guidance: { tune: AxisGuide; load: AxisGuide } | null;
}

/** The panel message's cases (matchmap/message.ts), cut to the actionable part. */
export function matchAidSummary(a: MatchAidInput): Segment[] {
  if (!a.map) return [{ text: "no map", tone: "muted" }];
  const r = a.result;
  if (!r || r.status === "none") return [{ text: "no reading", tone: "muted" }];
  if (r.status === "matched") return [{ text: "matched", tone: "live" }, { text: "hold" }];
  if (r.status === "nofit" || r.edge) return [{ text: "tune by hand", tone: "warn" }];
  if (r.status === "spot") {
    const moves = a.guidance
      ? (["tune", "load"] as const).filter((k) => a.guidance![k].dir === "up" || a.guidance![k].dir === "down")
      : [];
    if (!moves.length) return [{ text: "at match", tone: "live" }, { text: "hold" }];
    return moves.map((k): Segment => {
      const g = a.guidance![k];
      const amt = g.amount != null ? ` ${Math.abs(g.amount).toFixed(1)} %` : "";
      return { label: k === "tune" ? "Tune" : "Load", text: `${g.dir === "up" ? "↑" : "↓"}${amt}` };
    });
  }
  return [{ text: "need readings", tone: "muted" }];
}

// ---- Match tuner --------------------------------------------------------------------------
export function matchTunerSummary(mt: MatchTunerStatus | undefined): Segment[] {
  if (!mt) return [{ text: DASH }];
  if (!mt.running) return [{ text: mt.mode }, { text: "stopped", tone: "muted" }];
  const out: Segment[] = [{ text: mt.mode }, { text: mt.phase }];
  if (mt.armed) out.push({ text: "armed", tone: "warn" });
  if (mt.reverse_fraction != null) out.push({ label: "refl", text: pct1(mt.reverse_fraction) });
  return out;
}

// ---- Auto-shutoff timer -------------------------------------------------------------------
export function timerSummary(timer: TimerStatus | undefined): Segment[] {
  if (!timer) return [{ text: DASH }];
  if (timer.running) return [{ text: `${Math.ceil(timer.remaining_s / 60)} min left → RF off` }];
  if (timer.done) return [{ text: "elapsed" }, { text: "RF off", tone: "muted" }];
  return [{ text: "off", tone: "muted" }];
}

// ---- Recording ----------------------------------------------------------------------------
// recorder.py names the run dir "%Y%m%d_%H%M%S_<slug>" in the operator host's local time.
const RUN_STAMP = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(.+)$/;

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Elapsed is derived from the run-dir stamp vs `nowMs` (browser clock); it is omitted when the
 * stamp is unreadable or the clocks disagree (negative elapsed). */
export function recordingSummary(
  rec: { active: boolean; run: string | null } | undefined,
  nowMs: number,
): Segment[] {
  if (!rec) return [{ text: DASH }];
  if (!rec.active) return [{ text: "not recording", tone: "muted" }];
  if (!rec.run) return [{ text: "● REC", tone: "rec" }];
  const m = RUN_STAMP.exec(rec.run);
  if (!m) return [{ text: "● REC", tone: "rec" }, { text: rec.run }];
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const elapsed = nowMs - new Date(y, mo - 1, d, h, mi, s).getTime();
  const name: Segment = { text: m[7] };
  return elapsed >= 0
    ? [{ label: "● REC", text: fmtElapsed(elapsed), tone: "rec" }, name]
    : [{ text: "● REC", tone: "rec" }, name];
}
