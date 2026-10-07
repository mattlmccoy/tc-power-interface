/** m:ss for durations in seconds (cockpit timers, time to target).
 *  Negative or non-finite input is unknown: returns an em dash, never "0:00". */
export function mmss(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}

/** One decimal, or an em dash for unknown (never 0 for a missing value). */
export function f1(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? "—" : x.toFixed(1);
}
