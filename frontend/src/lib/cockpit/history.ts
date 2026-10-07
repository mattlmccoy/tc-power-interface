import type { Status } from "../telemetry.ts";

/** One live cockpit sample (from /api/status), keyed by the generator telemetry timestamp. */
export interface CockpitSample {
  ns: number;
  run: string | null;
  /** Telemetry `rf_on`: retune ticks and reflected % only count while RF is on. */
  rf: boolean;
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

const num = (x: number | null | undefined): number | null => (x != null && Number.isFinite(x) ? x : null);

/**
 * The cockpit sample for one `/api/status` snapshot, or null without generator telemetry (nothing
 * to key it on). Unknowns stay null, never 0: an older operator without `thermal.shadow`/`watch` or
 * cap readback, and a watched ROI that is not in the feed (backend core_watch.py: temp_c null).
 */
export function sampleFromStatus(status: Status | null): CockpitSample | null {
  const tel = status?.controller?.telemetry;
  if (!tel) return null;
  const th = status.thermal;
  const watch: Record<string, number | null> = {};
  for (const w of th?.watch ?? []) watch[w.name] = num(w.temp_c);
  return {
    ns: tel.host_timestamp_ns,
    run: status.recording?.run ?? null,
    rf: tel.rf_on === true,
    fwd: tel.forward_w,
    rev: tel.reverse_w,
    part: num(th?.control_temp_c),
    watch,
    suggest: num(th?.shadow?.suggest_w),
    tune: num(tel.tune_cap_percent),
    load: num(tel.load_cap_percent),
  };
}
