// Link heartbeat + RF on-time clock: pure view logic for the top bar (no React, unit-tested).
//
// GEN = operator <-> generator: the controller's good-read counter and the age of the last good read
// (`status.controller.link`). APP = browser <-> operator: time since the last WebSocket message. The
// RF clock text comes from `status.rf_clock`. Unknown is never shown as healthy.

/** `status.controller.link` (absent on backends older than v0.17.3). */
export interface LinkBlock {
  poll_seq: number;
  /** Seconds since the last good generator read; null = no good read yet. */
  last_ok_age_s: number | null;
  /** Consecutive failed reads (0 after any good read). */
  read_failures: number;
}

/** `status.rf_clock` (absent on backends older than v0.17.3). */
export interface RfClockBlock {
  rf_on: boolean | null;
  burn_s: number | null;
  last_burn_s: number | null;
  run_rf_on_s: number;
  run: string | null;
  stale: boolean;
  /** RF state observed on the CURRENT device link (false = no generator: neutral, not a fault). */
  known?: boolean;
  /** The finished run's RF-on total, until RF turns on again or a new run starts. */
  last_run_rf_on_s?: number | null;
}

export type HealthTone = "ok" | "slow" | "dead" | "unknown";
export interface Health {
  tone: HealthTone;
  label: string;
}

export const GEN_OK_MAX_S = 1.5;
export const GEN_SLOW_MAX_S = 5.0;
export const APP_OK_MAX_MS = 2000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `m:ss` under an hour, `h:mm:ss` from an hour; "—" when unknown. Floors (never runs ahead). */
export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

const secLabel = (s: number) => `${s.toFixed(1)} s`;

/** GEN LED: is the operator still getting replies from the generator? */
export function genHealth(link: LinkBlock | null | undefined, connected: boolean): Health {
  if (!connected || !link) return { tone: "unknown", label: "—" };
  const age = link.last_ok_age_s;
  if (age == null) return { tone: "dead", label: "no read" };
  const label = secLabel(age);
  if (age > GEN_SLOW_MAX_S) return { tone: "dead", label };
  if (age > GEN_OK_MAX_S || link.read_failures >= 1) return { tone: "slow", label };
  return { tone: "ok", label };
}

/** APP LED: is the browser still receiving updates from the operator? */
export function appHealth(msSinceLastMessage: number | null): Health {
  if (msSinceLastMessage == null) return { tone: "unknown", label: "—" };
  const label = secLabel(msSinceLastMessage / 1000);
  return { tone: msSinceLastMessage <= APP_OK_MAX_MS ? "ok" : "dead", label };
}

export interface RfClockView {
  text: string;
  tone: "live" | "muted" | "warn";
}

/** The top-bar RF clock text, or null when the backend has no clock (render nothing).
 * - not `known` (no generator / never read / detached): neutral "RF —", never a warning;
 * - known but `stale`, or `appAlive` false (the block is a frozen copy): a LOST link, warn. */
export function rfClockView(
  rc: RfClockBlock | null | undefined,
  appAlive = true,
): RfClockView | null {
  if (!rc) return null;
  const known = rc.known ?? rc.rf_on != null; // older backends have no `known`
  if (!known) return { text: "RF —", tone: "muted" };
  if (rc.stale || !appAlive) return { text: "RF ? · no data", tone: "warn" };
  const run =
    rc.run != null
      ? ` · run ${fmtDuration(rc.run_rf_on_s)}`
      : rc.last_run_rf_on_s != null
        ? ` · last run ${fmtDuration(rc.last_run_rf_on_s)}`
        : "";
  if (rc.rf_on) return { text: `RF ON ${fmtDuration(rc.burn_s)}${run}`, tone: "live" };
  const last = rc.last_burn_s != null ? ` · last ${fmtDuration(rc.last_burn_s)}` : "";
  return { text: `RF off${last}${run}`, tone: "muted" };
}
