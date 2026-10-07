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
 * array is returned (React sees no change). A non-null `run` that differs from the last sample's
 * starts a fresh buffer; `run: null` (unknown / not recording) never resets. Never mutates `buf`.
 */
export function appendSample(buf: CockpitSample[], s: CockpitSample, maxN: number): CockpitSample[] {
  const last = buf[buf.length - 1];
  if (last && s.run !== null && last.run !== s.run) return [s];
  if (last && s.ns <= last.ns) return buf;
  const next = [...buf, s];
  return next.length > maxN ? next.slice(next.length - maxN) : next;
}
