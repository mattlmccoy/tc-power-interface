/** One live cockpit sample (from /api/status), keyed by the generator telemetry timestamp. */
export interface CockpitSample {
  ns: number;
  run: string | null;
  fwd: number;
  rev: number;
  part: number | null;
  watch: Record<string, number | null>;
  suggest: number | null;
  tune: number | null;
  load: number | null;
}

/**
 * Append if new; the websocket re-sends the same telemetry at 10 Hz, so a sample whose `ns` is not
 * strictly newer than the last one (a repeat or an out-of-order straggler) is dropped and the SAME
 * array is returned (React sees no change). A fresh buffer starts only when a non-null `run`
 * differs from the LAST NON-NULL run seen in the buffer (r1 -> r2, or r1 -> null -> r2). `run: null`
 * (unknown / not recording) never resets, and neither does null -> r1 (starting a recording keeps
 * the pre-recording timeline). Never mutates `buf`.
 */
export function appendSample(buf: CockpitSample[], s: CockpitSample, maxN: number): CockpitSample[] {
  const last = buf[buf.length - 1];
  const prevRun = s.run !== null ? lastRun(buf) : null;
  if (prevRun !== null && prevRun !== s.run) return [s];
  if (last && s.ns <= last.ns) return buf;
  const next = [...buf, s];
  return next.length > maxN ? next.slice(next.length - maxN) : next;
}

/** The most recent non-null run id in the buffer, or null if no sample has one. */
function lastRun(buf: CockpitSample[]): string | null {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i].run !== null) return buf[i].run;
  return null;
}
