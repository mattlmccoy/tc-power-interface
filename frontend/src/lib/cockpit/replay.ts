// Parse a recorded telemetry.csv and compare the run with the shadow loop's replay.
//
// File contract (backend/tc_power_interface/recording/recorder.py, `_CSV_FIELDS`): csv.DictWriter
// output, so CRLF line endings; `rf_on` is written from a Python bool ("True"/"False"); unknown =
// blank cell; `host_timestamp_ns` is an integer (~1.8e18, beyond 2^53, so it is differenced as a
// BigInt); any cell holding a comma or quote is RFC-4180 quoted. That can really happen: `part_roi`
// is a user-drawn FLIR ROI name, so a plain split(",") is NOT safe and a quote-aware parser is used.

/** One telemetry row. null = the cell was blank or not a finite number (never 0). */
export interface ReplayRow {
  /** Seconds since the first valid row. */
  t_s: number;
  forward_w: number | null;
  reverse_w: number | null;
  /** "True" (any case) = on; blank/anything else = off. The recorder always writes the cell. */
  rf_on: boolean;
  tune: number | null;
  load: number | null;
  /** Commanded setpoint, W. Blank = unknown (not 0). */
  setpoint_w: number | null;
  part_temp_c: number | null;
}

export interface ReplayStats {
  /** Mean |setpoint − shadow suggestion| over RF-on rows where both are known; null if none. */
  meanAbsDiffW: number | null;
  /** Seconds with reflected power above 1 % of forward. */
  reflHighS: number;
  /** Seconds with RF on. */
  rfOnS: number;
}

export interface ReplayEvent {
  t_s: number;
  text: string;
}

/** Timestamps before 2020-01-01 UTC cannot be from this tool (a corrupt "0"); the backend replay
 * (recording/replay_shadow.py MIN_PLAUSIBLE_NS) skips them too, keeping t_s origins identical. */
const MIN_PLAUSIBLE_NS = 1_577_836_800n * 1_000_000_000n;
const REFLECTED_HIGH = 0.01;
const RETUNE_MIN_PCT = 0.5;
/** A shadow point farther than this from a row is not "the same moment" (the replay's own ROI join
 * tolerance, backend/recording/replay_shadow.py JOIN_TOLERANCE_NS, is also 2 s). */
const MATCH_TOLERANCE_S = 2;

/** RFC-4180 records: quoted fields may hold commas, doubled quotes and line breaks; CRLF/LF/CR end a
 * record; blank lines are dropped. A last record without its line ending is returned. */
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
  endRec();
  return out;
}

const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse telemetry.csv text. Rows whose timestamp is missing/non-numeric, that are shorter than the
 * header (cut mid-write), whose timestamp is implausible (< 2020), or whose time goes BACKWARDS are skipped, so the result is time-sorted.
 * Throws if the text has records but no `host_timestamp_ns` column (a damaged / foreign file is not
 * an empty run); empty text gives [].
 */
export function parseTelemetryCsv(text: string): ReplayRow[] {
  const recs = csvRecords(text);
  if (recs.length === 0) return [];
  const header = recs[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iTs = col("host_timestamp_ns");
  if (iTs < 0) throw new Error("not a telemetry.csv: no host_timestamp_ns column");
  const idx = {
    fwd: col("forward_w"), rev: col("reverse_w"), rf: col("rf_on"), tune: col("tune_cap_percent"),
    load: col("load_cap_percent"), sp: col("setpoint_w"), part: col("part_temp_c"),
  };
  const get = (r: string[], i: number) => (i < 0 ? undefined : r[i]);
  const rows: ReplayRow[] = [];
  let ns0: bigint | null = null;
  for (let k = 1; k < recs.length; k++) {
    const r = recs[k];
    if (r.length < header.length) continue;
    const ts = r[iTs].trim();
    if (!/^\d+$/.test(ts)) continue;
    const ns = BigInt(ts);
    if (ns < MIN_PLAUSIBLE_NS) continue;
    if (ns0 === null) ns0 = ns;
    const t_s = Number(ns - ns0) / 1e9;
    if (rows.length > 0 && t_s < rows[rows.length - 1].t_s) continue;
    rows.push({
      t_s,
      forward_w: num(get(r, idx.fwd)),
      reverse_w: num(get(r, idx.rev)),
      rf_on: (get(r, idx.rf) ?? "").trim().toLowerCase() === "true",
      tune: num(get(r, idx.tune)),
      load: num(get(r, idx.load)),
      setpoint_w: num(get(r, idx.sp)),
      part_temp_c: num(get(r, idx.part)),
    });
  }
  return rows;
}

/** Reflected above 1 % of forward, from a real reading only (null if either is blank or fwd is 0). */
function reflectedHigh(r: ReplayRow): boolean | null {
  if (r.forward_w === null || r.reverse_w === null || r.forward_w <= 0) return null;
  return r.reverse_w > REFLECTED_HIGH * r.forward_w;
}

/**
 * Compare the run with the shadow replay. Each interval (previous row, this row] is credited to this
 * row's state, so a run that is RF-on in rows 1..n adds up to t_n − t_0. Blank forward/reverse count
 * as 0 here (no reading = no reflected time), unlike in runEvents. Both inputs must be time-sorted:
 * the nearest shadow point is found with one two-pointer walk (O(n + m)). A row is compared only when
 * RF is on, the setpoint is known, and the nearest shadow point is within 2 s and has a suggestion.
 */
export function compareStats(
  rows: ReplayRow[],
  shadow: { t_s: number; suggest_w: number | null }[],
): ReplayStats {
  let reflHighS = 0, rfOnS = 0, sum = 0, n = 0, j = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dt = i > 0 ? r.t_s - rows[i - 1].t_s : 0;
    if (r.rf_on) rfOnS += dt;
    if (reflectedHigh({ ...r, forward_w: r.forward_w ?? 0, reverse_w: r.reverse_w ?? 0 })) reflHighS += dt;
    if (!r.rf_on || r.setpoint_w === null || shadow.length === 0) continue;
    while (j + 1 < shadow.length && Math.abs(shadow[j + 1].t_s - r.t_s) <= Math.abs(shadow[j].t_s - r.t_s)) j++;
    const s = shadow[j];
    if (Math.abs(s.t_s - r.t_s) > MATCH_TOLERANCE_S || s.suggest_w === null) continue;
    sum += Math.abs(r.setpoint_w - s.suggest_w);
    n++;
  }
  return { meanAbsDiffW: n ? sum / n : null, reflHighS, rfOnS };
}

const fmt = (x: number): string => String(Math.round(x * 10) / 10);

/**
 * Notable moments, in time order: RF on / off edges, a setpoint change to a known value, a retune
 * (Tune or Load moved >= 0.5 % since the last retune, so slow drift accumulates), and reflected power
 * crossing above 1 % of forward. Events use REAL readings only: a blank forward/reverse/tune/load/
 * setpoint never fires or resets anything.
 */
export function runEvents(rows: ReplayRow[]): ReplayEvent[] {
  const ev: ReplayEvent[] = [];
  let rf = false;
  let sp: number | null = null;
  let refTune: number | null = null, refLoad: number | null = null;
  let high = false;
  for (const r of rows) {
    if (r.rf_on !== rf) { ev.push({ t_s: r.t_s, text: r.rf_on ? "RF on" : "RF off" }); rf = r.rf_on; }
    if (r.setpoint_w !== null) {
      if (r.setpoint_w !== sp) ev.push({ t_s: r.t_s, text: `setpoint → ${fmt(r.setpoint_w)} W` });
      sp = r.setpoint_w;
    }
    if (refTune === null) refTune = r.tune;
    if (refLoad === null) refLoad = r.load;
    const dT = r.tune !== null && refTune !== null ? Math.abs(r.tune - refTune) : 0;
    const dL = r.load !== null && refLoad !== null ? Math.abs(r.load - refLoad) : 0;
    if (dT >= RETUNE_MIN_PCT || dL >= RETUNE_MIN_PCT) {
      const nt = r.tune ?? refTune!, nl = r.load ?? refLoad!;
      ev.push({ t_s: r.t_s, text: `retune: Tune ${fmt(refTune!)}→${fmt(nt)} %, Load ${fmt(refLoad!)}→${fmt(nl)} %` });
      refTune = nt; refLoad = nl;
    }
    const h = reflectedHigh(r);
    if (h !== null) {
      if (h && !high) ev.push({ t_s: r.t_s, text: `reflected above 1 % (${fmt(r.reverse_w!)} W)` });
      high = h;
    }
  }
  return ev;
}
