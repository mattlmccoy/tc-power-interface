// Pure formatting + classification helpers (unit-tested with node --test).

/** CXN status bits (mirror of the backend Status IntFlag). */
export const STATUS_FLAGS: ReadonlyArray<readonly [number, string]> = [
  [1, "RF_ENABLED"],
  [16, "EXTERNAL_RFSOURCE"],
  [32, "LOAD_POWER_LEVELING"],
  [64, "MCG_MODE"],
  [256, "FORWARD_POWER_LIMIT"],
  [512, "REVERSE_POWER_LIMIT"],
  [1024, "OVER_TEMPERATURE"],
  [2048, "INTERLOCK_OPEN"],
  [16384, "ANALOG_INTERFACE"],
];

export function fmtWatts(w: number): string {
  return `${w.toFixed(1)} W`;
}

/** " — lo–hi" hint for an editable field's hard bound, or "" if the bound is absent/malformed.
 *  Guards the Settings forms so a config payload without `bounds` can never crash the render. */
export function boundHint(
  bounds: Record<string, [number, number]> | undefined,
  key: string,
): string {
  const b = bounds?.[key];
  if (!Array.isArray(b) || b.length < 2) return "";
  return ` — ${b[0]}–${b[1]}`;
}

/** Best-effort readable message from any thrown value (Error, string, object, or nullish). */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err == null) return "Unknown error";
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function fmtTemp(c: number): string {
  return `${c.toFixed(1)} °C`;
}

export type Zone = "ok" | "warn" | "trip";

/** Classify a reflected fraction against warn/trip thresholds (warn boundary is inclusive-ok). */
export function reflectedZone(fraction: number, warn: number, trip: number): Zone {
  if (fraction > trip) return "trip";
  if (fraction > warn) return "warn";
  return "ok";
}

export function statusFlagNames(status: number): string[] {
  return STATUS_FLAGS.filter(([bit]) => (status & bit) !== 0).map(([, name]) => name);
}

export interface FlirLinkResult {
  ok: boolean | null;
  message: string;
  ts: number;
}

/** Render the FLIR link's last_result as a one-line status: "idle" / "linked · ok" / "error: …". */
export function flirStatusLabel(last: FlirLinkResult | null): string {
  if (!last || last.ok === null) return "idle";
  return last.ok ? "linked · ok" : `error: ${last.message || "unknown"}`;
}
