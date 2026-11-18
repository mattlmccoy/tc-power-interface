// Run clock: a per-run RF-on-time REMINDER in the top bar. Pure display + sound decisions; the
// operator holds and counts the clock (backend control/run_clock.py), so every screen agrees and it
// keeps counting with the page closed. It never commands RF.

export type RunClockPhase = "off" | "running" | "paused" | "warn" | "final" | "over";

/** `/api/status → run_clock` (backend RunClock.snapshot). */
export interface RunClockBlock {
  set: boolean;
  target_s: number | null;
  /** RF-on time counted so far, s. */
  on_s: number | null;
  /** Target − RF-on time, s; negative = overtime. */
  remaining_s: number | null;
  phase: RunClockPhase;
  /** RF is on right now, so the clock is moving. */
  counting: boolean;
  /** The time's-up alert was acknowledged. */
  dismissed: boolean;
}

const OFF: RunClockBlock = {
  set: false, target_s: null, on_s: null, remaining_s: null, phase: "off", counting: false, dismissed: false,
};

/** m:ss under an hour, h:mm:ss above. Sign is dropped (the caller says "left" or "over"). */
export function fmtClock(seconds: number): string {
  const t = Math.abs(Math.trunc(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The pop-up's minutes and seconds boxes → seconds, or null if it is not a sensible target
 * (whole numbers, 0–1440 min, 0–59 s, more than zero in total). */
export function parseClockEntry(min: string, sec: string): number | null {
  const whole = (v: string, max: number): number | null => {
    const t = v.trim();
    if (t === "") return 0;
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n <= max ? n : null;
  };
  const m = whole(min, 1440);
  const s = whole(sec, 59);
  if (m === null || s === null) return null;
  const total = m * 60 + s;
  return total > 0 ? total : null;
}

export type ChipLevel = "idle" | "ok" | "paused" | "warn" | "final" | "over";

export interface ChipView {
  main: string;
  sub: string;
  level: ChipLevel;
  /** Progress through the target, 0–100. */
  pct: number;
}

/** What the top-bar chip shows. No clock set (or an operator older than v0.20) is a muted but
 * visible "Run clock" chip, so the feature is always easy to find. */
export function chipView(rc: RunClockBlock | undefined | null): ChipView {
  const c = rc ?? OFF;
  if (!c.set || c.target_s == null || c.remaining_s == null || c.on_s == null) {
    return { main: "Run clock", sub: "set RF-on time", level: "idle", pct: 0 };
  }
  const pct = Math.min(100, Math.max(0, Math.round((1000 * c.on_s) / c.target_s) / 10));
  const target = fmtClock(c.target_s);
  if (c.phase === "over") return { main: `+${fmtClock(-c.remaining_s)}`, sub: `over ${target}`, level: "over", pct: 100 };
  const main = fmtClock(Math.ceil(c.remaining_s)); // 0:00 only when it is really reached
  const sub = c.counting ? `left of ${target}` : "paused · RF off";
  const level: ChipLevel = c.phase === "warn" || c.phase === "final" ? c.phase : c.counting ? "ok" : "paused";
  return { main, sub, level, pct };
}

const RANK: Record<RunClockPhase, number> = { off: 0, running: 1, paused: 1, warn: 2, final: 3, over: 4 };

/** Sound for a phase change. One chime on ENTERING the 2-min and the 30-s warnings (never on page
 * load, never when +time moves it back). The time's-up sound repeats while over and not dismissed,
 * including right after the page opens: an unacknowledged overrun must still be heard. Silent when
 * the page is not hearing from the operator (``live`` false): a stale page cannot be dismissed. */
export function soundFor(
  prev: RunClockPhase | null,
  next: RunClockPhase,
  dismissed: boolean,
  live: boolean,
): { chime: boolean; repeat: boolean } {
  if (!live) return { chime: false, repeat: false };
  const chime = prev !== null && (next === "warn" || next === "final") && RANK[next] > RANK[prev];
  return { chime, repeat: next === "over" && !dismissed };
}

/** The fixed time's-up pop-up text, or null when there is nothing to acknowledge. */
export function overBanner(rc: RunClockBlock | undefined | null): string | null {
  if (!rc || rc.phase !== "over" || rc.dismissed || rc.target_s == null || rc.remaining_s == null) return null;
  return `Time's up: ${fmtClock(rc.target_s)} of RF-on time reached · +${fmtClock(-rc.remaining_s)} over`;
}
