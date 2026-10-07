# Closed-loop cockpit + shadow loop — design

2026-10-06. Status: **draft for Matt's review**. Replaces the 2026-09-08 closed-loop page design.

Mockup (approved direction, layout A): https://claude.ai/artifact/NpXFcTejYFQ2ZNk3i92gkw. It replays the
real 2026-10-02 full sweep with a prototype shadow loop.
Data findings this builds on: `docs/superpowers/notes/2026-10-06-closed-loop-data-findings.md`.

## 1. Decisions (Matt, 2026-10-06)

| # | Decision |
|---|---|
| D1 | The page is a **run cockpit plus a shadow loop**. The shadow loop computes what power it would set and shows it next to the operator's. It **never commands** anything in this build. |
| D2 | The shadow loop **estimates the part's heating response live**, during the run, and shows how confident the estimate is. |
| D3 | Transformer cores: **display and warn only**. The real interlock (RF off on core over-temperature or runaway rate) stays a separate build under the 09-25 interlock spec. |
| D4 | One cockpit serves all run types, picked with a run-mode selector, not tabs: power ladder, fixed power, to-temperature, and angle schedule (future, shown disabled). |
| D5 | It runs on a dedicated TC-POWER screen. |
| D6 | Layout A: a full-width run timeline, then three fixed columns: Power · Thermal · Match. |
| D7 | The shadow loop runs in the **backend**, and its output is recorded every sample. |
| D8 | A replay tool is built into the app, **only if properly useful**. Section 6 defines what that means. |
| D9 | Nothing that appears or changes during a run may shift the layout (`ui-no-layout-shift`). |

## 2. Data contracts (evidence)

| Input | Evidence |
|---|---|
| Part temperature = mean of the operator-chosen control ROI | `GET /api/live/roi-temps` on the FLIR tool; shape from captured payloads `backend/tests/test_flir_roi_temps.py` (`_LIVE_A70_HEALTHY`, etc.); selection `integration/flir_roi_temps.py:select_control_temp` |
| Why there is no reading | `control_status()` (v0.16.0): ok / no_roi_selected / roi_not_in_feed / not_live / no_feed / roi_invalid |
| Every ROI's mean temperature, cores included | the same feed's `rois[].mean_c`; already surfaced as `thermal.roi_temps` (`api/app.py:thermal_extra`) |
| ROI names change between prints | FLIR runs 09-08 → 10-02: `circle_medium_small` → `SQ_SAMPLE` → `freehand_sample`; cores `toroid_C`/`toroid_D` from 09-28 (findings note §1) |
| Forward/reflected power, Tune/Load readback | controller telemetry (`lib/telemetry.ts:3-17`); cap readback recorded since v0.11.0 |
| Telemetry cadence | about 0.5–0.6 s (`run 20260928_193906`, median 608 ms) |
| Reflected power resolution 0.1 W | cold-match analysis §D |
| Plant response | first-order fits (findings note §3): part 0.10–0.16 °C/(W·min) on the 10-01/10-02 networks, 0.03–0.04 earlier; time constant 2–4 min; cores 0.05–0.07 °C/(W·min) |
| Live-estimate behaviour on real data | mockup replay of FLIR `20261002_125228_Run`: confidence about 0 for the first ~7 min at steady power, then ~0.65–0.7 after the steps; K → ~0.5 °C/W, τ ~2.3–3 min |

## 3. Backend

### 3.1 What is observed (every telemetry tick, loop running or not)
- `part_temp_c`: the control ROI mean, or **None**, with `temp_status`. This is v0.16.0 behaviour, kept as is.
- `watch_rois`: an operator-chosen list of extra ROI names (cores first). It persists with the source choice in
  `.thermal_source.json` (`{"type", "roi", "watch": [...]}`). The default is empty, and no names are invented.
  Each watched ROI's mean is reported, or None with a reason (`not_in_feed` / `invalid`).
- Core rate of rise (°C/min) over a trailing 60 s window, per watched ROI. It is None until the window holds 60 s
  of valid samples.

### 3.2 Live estimator (new module `control/plant_estimator.py`, pure)
- Model: `dT/dt = a·P − b·(T − T_amb)`, giving K = a/b (°C/W) and τ = 1/b (s). T_amb = the part temperature at the
  first valid RF-on sample of the run.
- Resample to a fixed 5 s step. Derivative = central difference of a 30 s moving average.
- Recursive least squares with forgetting factor λ = 0.995. Residual variance is tracked as an EWMA (α = 0.05).
  Updates only while RF is on, P ≥ 1 W, and the temperature is valid.
- Confidence = clip(1 − (se_a/a + se_b/b), 0, 1) from the RLS covariance scaled by the residual variance.
- Output is valid only once there have been ≥ 6 updates and a > 0, b > 0. Otherwise every field is None ("learning").
- Resets at each new recording, the same rule as drift (`withRun`).

### 3.3 Shadow controller (new module `control/shadow_loop.py`, pure)
- PI tuned by the SIMC rule from the current estimate:
  τc = max(τ/2, 30 s), θ = 10 s (provisional; measure it in step 3 of §8), Kc = τ / (K·(τc+θ)),
  Ti = min(τ, 4(τc+θ)).
- Integral with anti-windup clamp [0, ceiling]. Suggestion clamped to [0, min(loop ceiling, max forward)] and
  rate-limited to `max_step_w` per 5 s.
- To-temperature mode also gives:
  - **Plateau at your power** = T_amb + K·P.
  - **Time to target** = −τ·ln((plateau − target)/(plateau − T)), only when plateau > target > T.
    Otherwise it says "won't reach target at this power (levels off ≈ plateau)".
- The shadow loop never calls `set_setpoint`. A test enforces this, as for the existing `ThermalController`.
- The existing `ThermalController` and its hard-coded PI (KP 8 / KI 2) are **left unchanged and not exposed in the
  cockpit**: no "auto" button in this build. Retiring or replacing it comes after the shadow loop has proven
  itself.

### 3.4 Recorded every sample (columns appended after existing ones; old readers unaffected)
`part_temp_c, temp_status, watch_<name>_c (one per watched ROI, up to 4), shadow_k, shadow_tau_s,
shadow_conf, shadow_suggest_w, shadow_plateau_c, shadow_ttt_s, run_mode, target_c`. Unknown is blank, never 0.

### 3.5 API
- `GET /api/status → thermal` gains `watch`, `shadow`, `run_mode`.
- `POST /api/thermal/watch {names: [...]}` saves the watched ROIs.
- `POST /api/run-mode {mode, params}`, where mode is ladder | fixed | target | angle (angle is rejected as not
  available). Params: the ladder step list; the fixed W and duration; target, soak and ceiling (reusing the
  thermal plan store).
- Run mode is **display and bookkeeping only**. It never changes power by itself (D1).

### 3.6 Known issue to fix in this build
Auto-recording can stay open after the generator disconnects. 2026-10-06: run `20261006_164701` stayed active
14+ min with no new rows after the generator went offline. Fix: stop the auto-started recording when the
generator auto-disconnects (`tc-power-link-loss-disconnect`). A manually started recording is left alone.

## 4. Frontend: the cockpit (replaces the Closed-loop tab)

Layout A, as in the mockup. Every element has a fixed position; alerts are pop-ups (D9).
- **Header row:** run mode chips · run name · network label (from the active map) · elapsed · energy (Wh).
- **Timeline (~45 % of the height):**
  - Temperature lane: part temperature, the target line in to-temperature mode, and watched ROIs (cores).
  - Power lane: your forward power (filled), the shadow suggestion (dashed), reflected % (right axis), and
    retune ticks.
  - Scrolls the last 15 min live, with "Whole run" as an option.
- **Power column:**
  - Forward and reflected readouts, the setpoint stepper (−25/−5/+5/+25), RF on/off and E-STOP (existing
    controls, moved here).
  - A mode panel:
    - Ladder: step list, current step, and a "Next step" button that sets the next setpoint. It is an operator
      action.
    - Fixed: W and a timer, reusing the existing auto-shutoff timer.
    - Target: target, soak and ceiling.
- **Thermal column:**
  - Part temperature and its rate; the target and time to target, or the plateau.
  - Shadow card: suggested W and Δ vs yours; K, τ and plateau; a confidence bar with its sentence (low / firming
    up / good).
  - Watched cores: temperature, rate, and a warn colour. The thresholds are set in Settings, defaulting to 45 °C
    and 3 °C/min, marked **provisional until set from run data**.
  - The temperature-status sentence (v0.16.0).
- **Match column:**
  - Tune/Load readback with −/+.
  - Reflected % chip.
  - Drift and travel (v0.13).
  - A compact match-aid line, with the full Match aid panel below the fold on the Dashboard.

Pure logic (TDD, `lib/cockpit/*`):
- Timeline scales and windows.
- Confidence → sentence.
- Plateau and time-to-target text.
- Core level (ok/warn).
- Ladder step bookkeeping.
- Run-mode panel state.

## 5. What "never acts" means, concretely
- Nothing in this build calls `set_setpoint`, `enable_rf` or a cap command, except the operator's own clicks.
  "Next step" is an operator click.
- The shadow loop's suggestion is shown and recorded, never applied. Tests assert no actuator calls from the
  estimator, shadow loop, watch ROIs or run mode.

## 6. Replay tool (in-app, "Runs" view)

It is worth building only because it answers questions the live cockpit can't:
1. "Would the shadow loop have done better than me?" Your power vs its suggestion, across a whole recorded run.
2. "Where did it start to drift, and what did I do?" Every retune, cap command and RF on/off on the timeline,
   from `events.json`.
3. "What was the core doing when reflected rose?" Temperatures and reflected % on one time axis.

Scope:
- **Run list:** from `GET /api/recordings`.
- **Opening a run:** loads `telemetry.csv` (and `events.json` if present) and renders the **same cockpit
  components** in replay mode: a scrubber, play/pause, panels showing the values at the cursor, and
  greyed-out future.
- **Comparison strip:** time-weighted mean |your W − shadow W|, and minutes spent with reflected > 1 %.
- **Older recordings (before this build):** they have no temperatures or shadow columns. The replay shows what
  they have (power, reflected, caps, events) and says "temperatures not recorded in this run". Re-running the
  shadow loop over old FLIR exports stays an offline script (`tools/flir/`), not in the app (YAGNI).
- **Read-only.** Nothing in replay mode can send a command. The power, RF and cap controls are replaced by
  read-only readouts.

## 7. Out of scope (this build)
- Any automatic power or cap action, including the core interlock, the auto loop, and auto-retune.
- The turntable and angle scheduling (selector shown disabled; pinned for discussion).
- Changing the FLIR tool.

## 8. Build order (each step TDD, then a browser check against the simulator)
1. Backend: watched ROIs and core rates, plus the recorder columns. Uses captured FLIR payload fixtures.
2. Backend: `plant_estimator`. Tests:
   - A synthetic first-order plant with power steps recovers K and τ within 10 %.
   - Constant power keeps confidence < 0.3.
   - **Real data:** the 10-02 FLIR trace, captured as a fixture, converges to K 0.35–0.65 °C/W and τ 100–250 s,
     with confidence ≥ 0.5 by the end.
3. Backend: `shadow_loop`. Tests: bounded and rate-limited output, never actuates, plateau and time-to-target
   maths. **θ check:** estimate the delay between a power step and the FLIR response on the real runs and
   replace the provisional 10 s.
4. Backend: run mode, the API, and the auto-recording fix (§3.6).
5. Frontend: pure cockpit logic, then the layout-A page (replacing Closed loop).
6. Frontend: the Runs (replay) view.
7. A real-data end-to-end run against the real FLIR tool on a scratch operator before deploy. Version 0.17.0.

## 9. Risks / open points
- **Identifiability:** at steady power, K and τ can't be separated. That's shown honestly; better in ladder runs.
- **Plant gain varies about 5× between network builds.** The estimate is per run by design, so nothing carries
  across builds.
- **Core warn thresholds are placeholders** until set from run data. The 09-24 runaway had no core ROIs on
  camera.
- **The surface ROI is not the core temperature** of the part (HEATR surface/core unvalidated). The shadow loop
  controls the surface mean only.
