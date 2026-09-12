// Pure audible-alert logic: map a telemetry snapshot to an alert LEVEL, and the small state-machine
// rules for when a chime edge fires and when the alarm loop sounds. Kept free of Web Audio / DOM so
// it is fully unit-testable; the actual sound synthesis lives in audio.ts and the wiring in
// useAudioAlerts.ts.

export type AlertLevel = "alarm" | "chime" | "none";

export interface AlertInput {
  /** Controller state: "disconnected" | "connected" | "fault" | "closed". */
  state: string;
  rfOn: boolean;
  /** Reverse (reflected) power, watts. */
  reverseW: number;
  /** The reflected-power TRIP limit, watts (the gauge "warn" zone is > 50% of this). */
  maxReflectedW: number;
  /** Advisory warnings from the controller snapshot. */
  warnings: string[];
}

/** The audible severity for one snapshot:
 * - ALARM  — any latched FAULT (extreme reflected power, over-temperature, interlock, stale telemetry).
 * - CHIME  — reflected power in the gauge's "warn" zone (> 50% of the reflected trip, while RF is on),
 *            OR any advisory warning present.
 * - NONE   — nothing to announce.
 * Reflected power is only meaningful while RF is on, and a zero/absent limit never chimes. */
export function alertLevelFor(i: AlertInput): AlertLevel {
  if (i.state === "fault") return "alarm";
  const reflectedWarn = i.rfOn && i.maxReflectedW > 0 && i.reverseW > 0.5 * i.maxReflectedW;
  if (reflectedWarn || i.warnings.length > 0) return "chime";
  return "none";
}

/** A chime fires ONCE on the rising edge INTO "chime" (never every tick while it persists, and never
 * on an escalation to alarm — that is the alarm's job). */
export function shouldChime(prev: AlertLevel, next: AlertLevel): boolean {
  return next === "chime" && prev !== "chime";
}

/** The alarm loop sounds while the level is "alarm" and the operator hasn't silenced it. */
export function alarmShouldSound(level: AlertLevel, dismissed: boolean): boolean {
  return level === "alarm" && !dismissed;
}

/** A "silence" dismiss quiets only the CURRENT alarm episode: it auto-clears the moment the level
 * leaves "alarm" (fault cleared or condition gone), so the next fault re-sounds. */
export function nextDismissed(level: AlertLevel, dismissed: boolean): boolean {
  return level === "alarm" ? dismissed : false;
}
