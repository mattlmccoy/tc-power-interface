// Parse a recorded telemetry.csv and compare the run with the shadow loop's replay.
//
// File contract (backend/tc_power_interface/recording/recorder.py, `_CSV_FIELDS`): csv.DictWriter
// output, so CRLF line endings; `rf_on` is written from a Python bool ("True"/"False"); unknown =
// blank cell; `host_timestamp_ns` is an integer (~1.8e18, beyond 2^53, so it is handled as a
// BigInt); any cell holding a comma or quote is RFC-4180 quoted. That can really happen: `part_roi`
// is a user-drawn FLIR ROI name, so a plain split(",") is NOT safe and a quote-aware parser is used.
//
// Row selection mirrors backend/tc_power_interface/recording/replay_shadow.py (`_rows` lines 78-90,
// `_timed_rows` lines 143-166) so this t_s axis equals the backend shadow replay's t_s axis.

/** One telemetry row. null = the cell was blank or not a finite number (never 0). */
export interface ReplayRow {
  /** Seconds since the first accepted row (same origin as the backend replay's t_s). */
  t_s: number;
  forward_w: number | null;
  reverse_w: number | null;
  /** "True" (any case) = on; blank/anything else = off. The recorder always writes the cell. */
  rf_on: boolean;
  tune: number | null;
  load: number | null;
  /** Commanded setpoint, W. Blank = unknown (not 0). Only recorded since 2026-10-07; not used by
   * the comparison (forward power is). */
  setpoint_w: number | null;
  part_temp_c: number | null;
}

export interface ReplayStats {
  /** Time-weighted mean |forward power − shadow suggestion| over the paired RF-on rows; null if none. */
  meanAbsDiffW: number | null;
  /** RF-on rows that had a forward reading and a shadow point with a suggestion within 2 s. */
  pairedRows: number;
  /** All RF-on rows, so the UI can say "mean over pairedRows of rfOnRows RF-on rows". */
  rfOnRows: number;
  /** Seconds with RF on (each interval credited at most maxDtS). */
  rfOnS: number;
  /** Seconds with RF on and reflected power above 1 % of forward (forward >= 1 W). */
  reflHighS: number;
  /** Seconds with no usable reading: a blank forward/reverse cell, plus the part of any gap
   * between rows beyond maxDtS. Never counted as healthy or as RF time. */
  unknownS: number;
}

export interface ReplayEvent {
  t_s: number;
  text: string;
}

// ---- backend parity constants (replay_shadow.py:36-45) -------------------------------------------
/** Timestamps before 2020-01-01 UTC cannot be from this tool (a corrupt "0"). */
const MIN_PLAUSIBLE_NS = 1_577_836_800n * 1_000_000_000n;
/** ... or more than a day past now. */
const FUTURE_SLACK_NS = 86_400n * 1_000_000_000n;
/** A jump of more than this past the previous good row is corrupt (or a stall), never a gap to fill. */
const MAX_GAP_NS = 3600n * 1_000_000_000n;

const REFLECTED_HIGH = 0.01;
/** Reflected power is only judged at >= 1 W forward: at lower power the ratio is noise. */
const REFLECTED_MIN_FORWARD_W = 1;
const RETUNE_MIN_PCT = 0.5;
/** A shadow point farther than this from a row is not "the same moment" (the replay's own ROI join
 * tolerance, replay_shadow.py JOIN_TOLERANCE_NS, is also 2 s). */
const MATCH_TOLERANCE_S = 2;
/** One row's interval is credited at most this long (default for compareStats). */
const MAX_DT_S = 2;

/** RFC-4180 records: quoted fields may hold commas, doubled quotes and line breaks; CRLF/LF/CR end a
 * record; blank lines are dropped. A final record NOT terminated by a line ending is dropped (the
 * backend's `_rows` does the same: a live recording is read while the last row may be cut mid-write,
 * e.g. "23.4" read as "2"). */
function csvRecords(text: string): string[][] {
  const out: string[][] = [];
  let rec: string[] = [];
  let cell = "";
  let quoted = false;
  let any = false; // the current record has content (so a blank line is not a record)
  const endCell = () => { rec.push(cell); cell = ""; };
  const endRec = () => {
    if (any) { endCell(); out.push(rec); }
    rec = []; cell = ""; any = false;
  };
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') { quoted = true; any = true; }
    else if (c === ",") { endCell(); any = true; }
    else if (c === "\n") endRec();
    else if (c === "\r") { if (s[i + 1] === "\n") i++; endRec(); }
    else { cell += c; any = true; }
  }
  return out; // whatever is pending in rec/cell was never terminated: dropped
}

const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse telemetry.csv text into time-sorted rows. Throws if there are records but the header lacks
 * `host_timestamp_ns`, `forward_w` or `rf_on` (the backend's required columns): a damaged or foreign
 * file is not an empty run. Empty text gives [].
 *
 * Rows skipped, as replay_shadow.py `_rows`/`_timed_rows` skip them: wrong cell count (short or
 * long), a non-integer timestamp, one outside [2020, now + 1 day], one that goes backwards, one more
 * than 3600 s past the previous good row, and a corrupt-but-plausible first row (the first anchor
 * must agree within 3600 s with the row after it). `nowMs` is injectable for tests.
 */
export function parseTelemetryCsv(text: string, nowMs: number = Date.now()): ReplayRow[] {
  const recs = csvRecords(text);
  if (recs.length === 0) return [];
  const header = recs[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iTs = col("host_timestamp_ns");
  for (const need of ["host_timestamp_ns", "forward_w", "rf_on"])
    if (col(need) < 0) throw new Error(`not a telemetry.csv: no ${need} column`);
  const idx = {
    fwd: col("forward_w"), rev: col("reverse_w"), rf: col("rf_on"), tune: col("tune_cap_percent"),
    load: col("load_cap_percent"), sp: col("setpoint_w"), part: col("part_temp_c"),
  };
  const get = (r: string[], i: number) => (i < 0 ? undefined : r[i]);
  const hi = BigInt(Math.trunc(nowMs)) * 1_000_000n + FUTURE_SLACK_NS;

  const accepted: { ns: bigint; r: string[] }[] = [];
  let prev: bigint | null = null;
  let cand: { ns: bigint; r: string[] } | null = null; // the first anchor, awaiting its successor
  const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
  for (let k = 1; k < recs.length; k++) {
    const r = recs[k];
    if (r.length !== header.length) continue;
    const ts = r[iTs].trim();
    if (!/^\d+$/.test(ts)) continue;
    const ns = BigInt(ts);
    if (ns < MIN_PLAUSIBLE_NS || ns > hi) continue;
    if (prev === null) {
      if (cand !== null && absDiff(ns, cand.ns) <= MAX_GAP_NS) {
        prev = cand.ns;
        accepted.push(cand);
      } else {
        cand = { ns, r };
        continue;
      }
    }
    const d = ns - prev;
    if (d >= 0n && d <= MAX_GAP_NS) { // backwards or a far jump: corrupt, never a gap to fill
      prev = ns;
      accepted.push({ ns, r });
    }
  }
  if (prev === null && cand !== null) accepted.push(cand); // a one-row run

  const ns0 = accepted.length ? accepted[0].ns : 0n;
  return accepted.map(({ ns, r }) => ({
    t_s: Number(ns - ns0) / 1e9,
    forward_w: num(get(r, idx.fwd)),
    reverse_w: num(get(r, idx.rev)),
    rf_on: (get(r, idx.rf) ?? "").trim().toLowerCase() === "true",
    tune: num(get(r, idx.tune)),
    load: num(get(r, idx.load)),
    setpoint_w: num(get(r, idx.sp)),
    part_temp_c: num(get(r, idx.part)),
  }));
}

/** Reflected above 1 % of forward at >= 1 W forward with RF on, from real readings only; null when
 * a reading is blank or the condition does not apply (so it is never a verdict either way). */
function reflectedHigh(r: ReplayRow): boolean | null {
  if (r.forward_w === null || r.reverse_w === null) return null;
  if (!r.rf_on || r.forward_w < REFLECTED_MIN_FORWARD_W) return false;
  return r.reverse_w > REFLECTED_HIGH * r.forward_w;
}

/**
 * Compare the run with the shadow replay. "You" is the FORWARD power (forward_w exists in every
 * recording; setpoint_w only since 2026-10-07 and is blank after a link loss or front-panel use),
 * which is also what the live cockpit compares with the suggestion.
 *
 * Each interval (previous row, this row] is credited to this row's state, at most `maxDtS` (default
 * 2 s): a stall is not credited to one row, and the uncovered rest is `unknownS`. The mean is
 * weighted by those credited seconds (the first row, with no interval, weighs 0; if every weight is
 * 0 the plain mean is used). Only RF-on rows with a forward reading and a shadow point with a
 * suggestion within 2 s are paired; the rest stay visible as rfOnRows − pairedRows. Both inputs must
 * be time-sorted: the nearest shadow point comes from one two-pointer walk, O(n + m).
 */
export function compareStats(
  rows: ReplayRow[],
  shadow: { t_s: number; suggest_w: number | null }[],
  opts: { maxDtS?: number } = {},
): ReplayStats {
  const cap = opts.maxDtS ?? MAX_DT_S;
  let rfOnS = 0, reflHighS = 0, unknownS = 0, rfOnRows = 0, pairedRows = 0;
  let sumW = 0, sumWD = 0, sumD = 0, j = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dt = i > 0 ? r.t_s - rows[i - 1].t_s : 0;
    const credit = Math.min(dt, cap);
    unknownS += dt - credit;
    if (r.forward_w === null || r.reverse_w === null) unknownS += credit;
    if (r.rf_on) { rfOnS += credit; rfOnRows++; }
    if (reflectedHigh(r)) reflHighS += credit;
    if (!r.rf_on || r.forward_w === null || shadow.length === 0) continue;
    while (j + 1 < shadow.length && Math.abs(shadow[j + 1].t_s - r.t_s) <= Math.abs(shadow[j].t_s - r.t_s)) j++;
    const s = shadow[j];
    if (Math.abs(s.t_s - r.t_s) > MATCH_TOLERANCE_S || s.suggest_w === null) continue;
    const d = Math.abs(r.forward_w - s.suggest_w);
    pairedRows++;
    sumW += credit; sumWD += credit * d; sumD += d;
  }
  const meanAbsDiffW = pairedRows === 0 ? null : sumW > 0 ? sumWD / sumW : sumD / pairedRows;
  return { meanAbsDiffW, pairedRows, rfOnRows, rfOnS, reflHighS, unknownS };
}

const fmt = (x: number): string => String(Math.round(x * 10) / 10);

/**
 * Notable moments, in time order: RF on / off edges, a setpoint change to a known value, a retune
 * (Tune or Load moved >= 0.5 % while RF is on, measured from the last retune so slow drift
 * accumulates), and reflected power crossing above 1 % of forward (>= 1 W, RF on). The retune
 * reference is (re)set at every RF-on edge: hand-tuning with RF off is not a retune. Events use
 * REAL readings only: a blank cell never fires or resets anything.
 */
export function runEvents(rows: ReplayRow[]): ReplayEvent[] {
  const ev: ReplayEvent[] = [];
  let rf = false;
  let sp: number | null = null;
  let refTune: number | null = null, refLoad: number | null = null;
  let high = false;
  for (const r of rows) {
    if (r.rf_on !== rf) {
      ev.push({ t_s: r.t_s, text: r.rf_on ? "RF on" : "RF off" });
      rf = r.rf_on;
      if (rf) { refTune = r.tune; refLoad = r.load; }
    }
    if (r.setpoint_w !== null) {
      if (r.setpoint_w !== sp) ev.push({ t_s: r.t_s, text: `setpoint → ${fmt(r.setpoint_w)} W` });
      sp = r.setpoint_w;
    }
    if (rf) {
      if (refTune === null) refTune = r.tune;
      if (refLoad === null) refLoad = r.load;
      const dT = r.tune !== null && refTune !== null ? Math.abs(r.tune - refTune) : 0;
      const dL = r.load !== null && refLoad !== null ? Math.abs(r.load - refLoad) : 0;
      if (dT >= RETUNE_MIN_PCT || dL >= RETUNE_MIN_PCT) {
        const nt = r.tune ?? refTune!, nl = r.load ?? refLoad!;
        ev.push({ t_s: r.t_s, text: `retune: Tune ${fmt(refTune!)}→${fmt(nt)} %, Load ${fmt(refLoad!)}→${fmt(nl)} %` });
        refTune = nt; refLoad = nl;
      }
    }
    const h = reflectedHigh(r);
    if (h !== null) {
      if (h && !high) ev.push({ t_s: r.t_s, text: `reflected above 1 % (${fmt(r.reverse_w!)} W)` });
      high = h;
    }
  }
  return ev;
}
