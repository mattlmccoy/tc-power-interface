import assert from "node:assert/strict";
import { test } from "node:test";

import { compareStats, parseTelemetryCsv, runEvents } from "./replay.ts";

// CAPTURED, not typed: written by backend/tc_power_interface/recording/recorder.py TelemetryRecorder
// (_CSV_FIELDS) driven with 5 snapshots, 2026-10-07. The recorder writes CRLF line endings
// (csv.DictWriter), rf_on as "True"/"False", unknown cells blank, and quotes a cell that holds a
// comma/quote (the last row's part_roi is `a,"b" c`). Only the 3 rows from Task 17's plan are used
// by the plan-semantics tests; the full 5-row file is parsed end-to-end below.
const HEADER =
  "host_timestamp_ns,forward_w,reverse_w,load_w,reflected_fraction,rf_on,temperature_c,operation_mode,tuner,status,controller_state,thermal_phase,thermal_mode,thermal_armed,thermal_control_temp_c,thermal_target_c,thermal_recommended_w,thermal_applied_w,tune_cap_percent,load_cap_percent,manual_mode,dc_voltage,preset_slot,setpoint_w,part_roi,part_temp_c,temp_status,shadow_k,shadow_tau_s,shadow_conf,shadow_suggest_w,shadow_plateau_c,shadow_ttt_s,run_mode,target_c";
const R0 = "1791000000000000000,0.0,0.0,0.0,0.0,False,25.0,analog tuner,manual,ok,connected,,,,,,,,20.1,10.6,True,0.0,,,SQ SAMPLE,,not_live,0.31,80.0,0.7,45.0,60.0,,ladder,";
const R1 = "1791000005000000000,40.0,0.1,39.9,0.0025,True,25.0,analog tuner,manual,ok,connected,,,,,,,,20.1,10.6,True,0.0,,40,SQ SAMPLE,30.5,ok,0.31,80.0,0.7,45.0,60.0,,ladder,";
const R2 = "1791000010000000000,40.0,0.8,39.2,0.02,True,25.0,analog tuner,manual,ok,connected,,,,,,,,19.1,10.6,True,0.0,,40,SQ SAMPLE,31.0,ok,0.31,80.0,0.7,45.0,60.0,,ladder,";
const R3 = "1791000015000000000,40.0,0.3,39.7,0.0075,True,25.0,analog tuner,manual,ok,connected,,,,,,,,19.1,10.6,True,0.0,,50,SQ SAMPLE,32.25,ok,0.31,80.0,0.7,45.0,60.0,,ladder,";
const R4 = '1791000020000000000,40.0,0.3,39.7,0.0075,True,25.0,analog tuner,manual,ok,connected,,,,,,,,19.1,10.6,True,0.0,,,"a,""b"" c",,not_live,0.31,80.0,0.7,45.0,60.0,,ladder,';

const CSV = [HEADER, R0, R1, R2].join("\n");
const CSV_REAL = [HEADER, R0, R1, R2, R3, R4].join("\r\n") + "\r\n"; // exactly as the recorder writes it

test("parseTelemetryCsv: seconds from start; blanks are null, never 0", () => {
  const r = parseTelemetryCsv(CSV);
  assert.equal(r.length, 3);
  assert.equal(r[1].t_s, 5);
  assert.equal(r[0].setpoint_w, null);
  assert.equal(r[0].part_temp_c, null);
  assert.equal(r[2].rf_on, true);
});

test("compareStats: |you − shadow| while it had an estimate; time reflected > 1 %", () => {
  const r = parseTelemetryCsv(CSV);
  const st = compareStats(r, [{ t_s: 5, suggest_w: 50 }, { t_s: 10, suggest_w: null }]);
  assert.equal(st.meanAbsDiffW, 10);
  assert.equal(st.reflHighS, 5);
  assert.equal(st.rfOnS, 10);
});

test("runEvents: RF on, setpoint changes and retunes, in time order", () => {
  const ev = runEvents(parseTelemetryCsv(CSV));
  assert.deepEqual(
    ev.map((e) => e.text),
    ["RF on", "setpoint → 40 W", "retune: Tune 20.1→19.1 %, Load 10.6→10.6 %", "reflected above 1 % (0.8 W)"],
  );
  assert.deepEqual(ev.map((e) => e.t_s), [5, 5, 10, 10]);
});

test("the real recorder file end to end: CRLF, trailing newline, a quoted cell with a comma and quotes", () => {
  const r = parseTelemetryCsv(CSV_REAL);
  assert.equal(r.length, 5);
  assert.deepEqual(r.map((x) => x.t_s), [0, 5, 10, 15, 20]);
  assert.deepEqual(r.map((x) => x.part_temp_c), [null, 30.5, 31, 32.25, null]);
  assert.deepEqual(r.map((x) => x.setpoint_w), [null, 40, 40, 50, null]);
  assert.deepEqual(r.map((x) => x.rf_on), [false, true, true, true, true]);
  assert.deepEqual(r.map((x) => x.tune), [20.1, 20.1, 19.1, 19.1, 19.1]);
  assert.equal(r[4].forward_w, 40); // the quoted cell did not shift the columns after it
  assert.equal(r[4].reverse_w, 0.3);
  const st = compareStats(r, []);
  assert.equal(st.meanAbsDiffW, null); // no shadow overlap: unknown, not 0
  assert.equal(st.rfOnS, 20);
  assert.equal(st.reflHighS, 5);
  assert.deepEqual(
    runEvents(r).map((e) => e.text),
    ["RF on", "setpoint → 40 W", "retune: Tune 20.1→19.1 %, Load 10.6→10.6 %", "reflected above 1 % (0.8 W)", "setpoint → 50 W"],
  );
});

test("a quoted field may hold commas, doubled quotes and a line break", () => {
  const csv = 'host_timestamp_ns,forward_w,part_roi\n1791000000000000000,1,"a,""b""\nc"\n1791000001000000000,2,x\n';
  const r = parseTelemetryCsv(csv);
  assert.equal(r.length, 2);
  assert.equal(r[1].forward_w, 2);
  assert.equal(r[1].t_s, 1);
});

test("rows with a missing or non-numeric timestamp are skipped; a truncated last row is skipped", () => {
  const csv = [HEADER, R0, ",40,0.1", "garbage," + R1.split(",").slice(1).join(","), R1, R2.split(",").slice(0, 7).join(",")].join("\n");
  const r = parseTelemetryCsv(csv);
  assert.deepEqual(r.map((x) => x.t_s), [0, 5]);
});

test("a timestamp that goes backwards is skipped, so the rows stay time-sorted", () => {
  const r = parseTelemetryCsv([HEADER, R1, R0, R2].join("\n"));
  assert.deepEqual(r.map((x) => x.t_s), [0, 5]);
});

test("a non-finite number is null; a blank forward/reverse reading is null, not 0", () => {
  const fwd = R1.replace(",40.0,0.1,", ",Infinity,,");
  const r = parseTelemetryCsv([HEADER, R0, fwd].join("\n"));
  assert.equal(r[1].forward_w, null);
  assert.equal(r[1].reverse_w, null);
  assert.equal(r[1].part_temp_c, 30.5);
});

test("a file without the recorder's timestamp column is damaged, not an empty run", () => {
  assert.throws(() => parseTelemetryCsv("a,b\n1,2\n"), /host_timestamp_ns/);
  assert.deepEqual(parseTelemetryCsv(""), []);
  assert.deepEqual(parseTelemetryCsv(HEADER + "\r\n"), []);
});

test("blank forward/reverse count as 0 in stats but never fire a reflected event", () => {
  const blank = R2.replace(",40.0,0.8,", ",,,");
  const r = parseTelemetryCsv([HEADER, R0, R1, blank].join("\n"));
  const st = compareStats(r, []);
  assert.equal(st.reflHighS, 0);
  assert.ok(!runEvents(r).some((e) => e.text.startsWith("reflected")));
});

test("compareStats pairs each row with the nearest shadow point within 2 s, two-pointer over sorted input", () => {
  const rows = parseTelemetryCsv([HEADER, R0, R1, R2, R3].join("\n")); // setpoints: -, 40, 40, 50 at 0,5,10,15
  const near = compareStats(rows, [
    { t_s: 4.5, suggest_w: 44 }, // row@5 -> |40-44| = 4
    { t_s: 11, suggest_w: 30 },  // row@10 -> |40-30| = 10
    { t_s: 15.5, suggest_w: 50 }, // row@15 -> 0
  ]);
  assert.equal(near.meanAbsDiffW, 14 / 3);
  const far = compareStats(rows, [{ t_s: 100, suggest_w: 50 }]); // nothing within 2 s
  assert.equal(far.meanAbsDiffW, null);
});

test("compareStats on 20k rows and 20k shadow points stays linear", () => {
  const n = 20000;
  const rows = Array.from({ length: n }, (_, i) => ({
    t_s: i * 0.5, forward_w: 40, reverse_w: 0, rf_on: true, tune: null, load: null, setpoint_w: 40, part_temp_c: null,
  }));
  const shadow = Array.from({ length: n }, (_, i) => ({ t_s: i * 0.5, suggest_w: 42 }));
  const t0 = performance.now();
  const st = compareStats(rows, shadow);
  assert.equal(st.meanAbsDiffW, 2);
  assert.ok(performance.now() - t0 < 500, "O(n·m) would take seconds here");
});

test("runEvents: RF off edge and slow retune drift accumulate against the last retune", () => {
  const row = (t: number, rf: boolean, tune: number) => ({
    t_s: t, forward_w: 40, reverse_w: 0, rf_on: rf, tune, load: 10, setpoint_w: 40, part_temp_c: null,
  });
  const ev = runEvents([row(0, true, 20), row(1, true, 19.8), row(2, true, 19.4), row(3, false, 19.4)]);
  assert.deepEqual(
    ev.map((e) => e.text),
    ["RF on", "setpoint → 40 W", "retune: Tune 20→19.4 %, Load 10→10 %", "RF off"],
  );
});

test("an implausible timestamp (before 2020, e.g. a corrupt \"0\") is skipped, as the backend replay skips it, so t_s origins agree", () => {
  const zero = "0," + R0.split(",").slice(1).join(",");
  const r = parseTelemetryCsv([HEADER, zero, R0, R1].join("\n"));
  assert.deepEqual(r.map((x) => x.t_s), [0, 5]); // origin is R0, not the corrupt row
});
