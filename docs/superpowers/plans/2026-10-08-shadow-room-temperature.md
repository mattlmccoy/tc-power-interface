# Shadow room temperature (warm-start fix) Implementation Plan

**Goal:** the shadow loop never learns from a wrong room temperature. Today `plant_estimator.py:96-97`
takes the part temperature at the first RF-on sample as room temperature. Run 20261007_171928 started
warm (29.1 °C vs a 22.8 °C room), and replay through v0.18.4 gives K 0.30 °C/W (truth ≈0.43-0.51),
"needs ≈517 W" and 0.73 confidence shown: a confident wrong answer.

**Approach:** decide the room temperature once per run, at the first RF-on tick, in this order:

1. **Part at rest:** at least 50 s of RF-off part readings in the 60 s before RF on, the last one
   within 5 s of RF on, and |slope| ≤ 0.3 °C/min → room = the part temperature at RF on (today's
   value, now verified).
2. **Room reference ROI** (operator-picked, persisted like the control ROI): its live reading at RF on.
3. **Neither:** the shadow pauses for the run (no estimate, confidence 0), and the reason is shown:
   `part_cooling` / `part_warming` (with the slope), `rf_recent` (RF was on in the window), or
   `no_history`.

**Evidence for the constants**
- The RF-on room temperature error is about `slope x tau`. At 0.3 °C/min and tau 140-280 s
  (fits of runs 165850/171928), the error is 0.7-1.4 °C. Against the 15-25 °C rise seen at 30-55 W,
  that is a ≤ ~9 % K error. Run 171928's start slope was about 1.8 °C/min (cooling tau ≈214 s from
  29.1 → 22.8), 6× over the limit.
- FLIR part-mean noise: the 2-pole fit residual on run 165850 is 0.096 °C rms. Over 60 s at 2
  ticks/s, the slope standard error is ≈0.035 °C/min, so the 0.3 limit sits about 9 σ above noise.
- No recording holds an at-rest stretch before RF. TC-POWER recordings start at RF on, and the FLIR
  recordings start about 4 s before RF ON (frames 37794 → 37915). So the warm-start test prepends a
  SYNTHETIC cooling segment, built from the measured endpoints (37.9 °C at RF off 17:11:39 →
  29.1 °C at RF on 17:19:29, room 22.8), to the REAL run-2 telemetry. The test says so.
- No existing ROI is a clean room reference. `shunt_cap_FP` read 24.1 °C at run 2's start against
  a 22.8 °C room, because it warms in runs too. That is why the reference is the operator's pick and
  ranks after a rested part.

**Replay** (`recording/replay_shadow.py`): recordings start at RF on, so they carry no pre-RF
history. New recordings get `shadow_amb_c` and `shadow_amb_src` columns, and replay uses the
recorded decision. Older recordings replay with source `assumed` (first reading, unverified), and
the UI labels it that way.

**Tasks (red → green each)**
1. `control/ambient.py`: pure `judge_ambient(history, t_on, part_temp, ref_name, ref_temp)` → `Ambient`.
2. `PlantEstimator.fix_ambient(t_c | None)`: an explicit room temperature; None = do not learn this
   run. Auto-latch stays for direct callers (existing tests).
3. `CockpitObserver`: a ring buffer of pre-RF readings (not reset per run), judges at the first RF-on
   tick, calls `fix_ambient`, and adds `ambient` + `why: "room_unknown"` to the shadow block and
   `shadow_amb_c` / `shadow_amb_src` to the record fields. Uses the real run-2 data with the
   synthetic prefix.
4. Settings/API: `ambient_roi` in `thermal_store` + `POST /api/thermal/ambient`, and in `/api/status`
   and `/api/thermal/rois`. App wiring passes it to the observer.
5. Replay: honour the recorded `shadow_amb_*`, else `assumed`.
6. Recorder: new columns.
7. Frontend: `Shadow.ambient` type; `shadowCard`/`confidenceSentence` reasons; a "Room" line in the
   key-value list; a "Room reference" select in ThermalColumn; `api.setAmbientRoi`. Logic is TDD'd
   in `shadowText.ts`; the select is UI, so it's verified in the browser.
8. Version 0.19.0. Deploy needs an operator restart: ask Matt first and check RF is off.
