# Closed-loop redesign: what the FLIR + TC-POWER data says (2026-10-06)

Source: the FLIR tool's API (v0.4.53, `/Volumes/FLIR SSD/FLIR-recordings`), read-only. 23 runs, 09-08 to
10-02, have both the TC-POWER control stream (forward/reflected power; Tune/Load from 09-24, v0.11.0) and
ROI temperature series. Pull script and analysis: session scratchpad `flir/` (fetch_all.py, runview.py,
thermfit.py). Numbers below are preliminary analysis, not validated models.

## 1. The FLIR temperature never reached TC-POWER's thermal loop (since ~09-08)
- TC-POWER defaults the control ROI to `circle_medium_small` (`backend/tc_power_interface/api/app.py:264`,
  `integration/flir_roi_temps.py:72`). The live FLIR session's ROIs are `shunt_cap_FP, series_cap_FP,
  transformer_panel, front/back_electrode, SQ_SAMPLE, powder_circle, short_windings, toroid_C, toroid_D,
  freehand_sample`. No ROI has that name, so the control temperature never resolves, and the setting resets
  to the default on every operator restart.
- TC-POWER recordings store that missing value as **0 °C** in 43 of 45 runs: unknown shown as a valid reading
  (data-contract rule 5).
- The part ROI name changes between runs (`SQ_SAMPLE` → `freehand_sample` from 09-30; none on 09-08).

## 2. The part is nowhere near the 185 °C target at the ROI mean
- Best part-ROI mean was 58.6 °C (10-02 sweep, 91 W, 11.3 Wh). 09-11 ran 201 W for 30 min (89 Wh) and
  reached 41 °C. Hottest pixels reached about 122 °C.

## 3. Thermal response (first-order fits, R² > 0.8 runs)
- Part: initial heating rate 0.10–0.16 °C/(W·min) on the 10-01/10-02 networks, 0.03–0.04 on the
  09-24/09-30 networks (about 5× spread between network builds). Time constant 2–4 min.
- Transformer cores (toroid_C/D): 0.05–0.07 °C/(W·min), time constant 1.5–4 min (about 10 °C/min at
  200 W initially).
- The first-order model fails on long ramps (10-02 full sweep R² −0.23): steady climb, no plateau.
- The backend PI (`thermal_loop.py`: KP 8 W/°C, KI 2 W/(°C·s)) was never fitted. For the identified plant,
  a SIMC-style tuning gives roughly KP ~6 W/°C and KI ~0.03 W/(°C·s): the integral gain is about 60× too
  high. Gains must be identified per session, since the plant gain varies about 5× with the network.

## 4. Matching drift depends on the network build
- 330 sh build (cold T19.8/L10.6): Tune drifted −7 % over 8.2 Wh and hit the bottom of the AIT.
- 300 sh build (cold T30.8/L30.1): Load −4.6 % and Tune −1 % over 11.3 Wh, with plenty of travel left.
- Within a run, matched Tune correlates with core temperature (r −0.93) and with energy (r −0.98). Everything
  heats together, so one run cannot separate the cause.
- θ (dead time, power step → part response), 10-02 run via tools/flir/dead_time.py: freehand_sample 0 s, SQ_SAMPLE 0 s (6 power steps) → DEAD_TIME_S = 0.0. Limits: 5 s grid, lag 0 is the lower search edge and lag −5 s scores almost as high (3.53 vs 4.03), so the true θ is only bounded to ≲ 5 s; with 6 steps the estimate is weak. SIMC end suggestion moved 70.7 → 72.3 W (θ=5 would give 71.5 W).
