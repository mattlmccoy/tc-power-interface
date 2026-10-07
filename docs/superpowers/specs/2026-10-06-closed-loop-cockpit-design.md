# Closed-loop cockpit + shadow loop — design

2026-10-06, revised 2026-10-07 after mockups v3–v4. Status: **draft for Matt's review**. Replaces the 2026-09-08
closed-loop page design.

Mockup v4: https://claude.ai/artifact/NpXFcTejYFQ2ZNk3i92gkw. It replays the real 2026-10-02 full sweep with all
11 FLIR ROIs and recomputes the shadow loop in the page, with this spec's rules, for whichever ROI is picked.
Data findings this builds on: `docs/superpowers/notes/2026-10-06-closed-loop-data-findings.md`.

## 1. Decisions (Matt, 2026-10-06)

| # | Decision |
|---|---|
| D1 | The page is a **run cockpit plus a shadow loop**. The shadow loop computes what power it would set and shows it next to the operator's. It **never commands** anything in this build. |
| D2 | The shadow loop **estimates the part's heating response live**, during the run, and shows how confident the estimate is. |
| D3 | Transformer cores: **display and warn only**. The real interlock (RF off on core over-temperature or runaway rate) stays a separate build under the 09-25 interlock spec. |
| D4 | One cockpit serves all run types, picked with a run-mode selector, not tabs: power ladder, fixed power, to-temperature, and angle schedule (future, shown disabled). |
| D5 | It runs on a dedicated TC-POWER screen. |
| D6 | Layout (v4): a fixed **control strip** at the top (analog power dials · setpoint · Tune/Load), then the full-width run timeline, then three columns: Thermal · Run mode · Watched ROIs + drift. |
| D7 | The shadow loop runs in the **backend**, and its output is recorded every sample. |
| D8 | A replay tool is built into the app, **only if properly useful**. Section 6 defines what that means. |
| D9 | Nothing that appears or changes during a run may shift the layout (`ui-no-layout-shift`). |
| D10 | (2026-10-07) Power is read on the **Dashboard's analog dials** (Requested, Forward, Load, Reverse), not digital cards. Power is set with the Dashboard's setpoint entry. Tune/Load −/+ are large and always visible. Tuning stays **manual**: no auto-retune until the transformer-temperature interlock exists. |
| D11 | (2026-10-07) The control ROI is **picked from the live FLIR ROIs**, or from the ROIs recorded in a run when replaying. Replay can re-run the shadow loop on a different ROI, so every ROI's temperature is recorded. |
| D12 | (2026-10-07) Temperature-loop control comes in **two steps**. This build (v0.17) shows the loop's slot and gates with Engage locked. The next build (v0.18) adds the core interlock; Engage then unlocks once the shadow loop has proven itself on a few real runs at power. |

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
- `watch_rois`: an operator-chosen list of up to 4 extra ROI names (cores first). It persists with the source
  choice in `.thermal_source.json` (`{"type", "roi", "watch": [...]}`). The default is empty, and no names are
  invented. Each watched ROI's mean is reported, or None with a reason (`not_in_feed` / `invalid`).
- `roi_temps`: every ROI in the feed (name → mean or None), already surfaced as `thermal.roi_temps`. All of
  them are recorded (§3.4) so a replay can pick any ROI.
- Core rate of rise (°C/min) over a trailing 60 s window, per watched ROI. It is None until the window holds 60 s
  of valid samples.

### 3.2 Live estimator (new module `control/plant_estimator.py`, pure)
- Model: `dT/dt = a·P − b·(T − T_amb)`, giving K = a/b (°C/W) and τ = 1/b (s). T_amb = the part temperature at the
  first valid RF-on sample of the run.
- Resample to a fixed 5 s step. Derivative = central difference of a 30 s moving average.
- Recursive least squares with forgetting factor λ = 0.995. Residual variance is tracked as an EWMA (α = 0.05).
  Updates only while RF is on, P ≥ 1 W, and the temperature is valid.
- Confidence = clip(1 − (se_a/a + se_b/b), 0, 1) from the RLS covariance scaled by the residual variance.
- Output is valid only once there have been ≥ 6 updates and a > 0, b > 0. Otherwise every field is None ("learning")
  Also invalid when confidence is 0 (added 2026-10-07: on steady power the fit can have a, b > 0 but be pure
  noise, e.g. K 1–5 °C/W at 0 % confidence; that must read as learning, never as an estimate). Confidence is a
  heuristic score, not a probability. Missed 5 s grid steps are filled with unknowns, so a stalled poll loop
  can't squash time, and the covariance is capped so a long steady hold doesn't decay the estimate.
- Resets at each new recording, the same rule as drift (`withRun`).

### 3.3 Shadow controller (new module `control/shadow_loop.py`, pure)
- PI tuned by the SIMC rule from the current estimate:
  τc = max(τ/2, 30 s), θ = 10 s (provisional; measure it in step 3 of §8), Kc = τ / (K·(τc+θ)),
  Ti = min(τ, 4(τc+θ)).
- The integral starts at the operator's current power when the estimate first becomes valid (bumpless).
  Anti-windup clamp [0, ceiling]. Suggestion clamped to [0, min(loop ceiling, max forward)] and rate-limited to
  `max_step_w` (10 W) per 5 s. Evidence: without the bumpless start, the prototype's suggestion wound up to
  ~99 W at the end of the 10-02 run; with it, ~61 W, which matches holding 55 °C at K ≈ 0.5 °C/W from ~24 °C.
- Output by run mode: **to-temperature** → suggested W and Δ vs yours; **ladder / fixed** → no suggestion;
  "at your power the part levels off at ≈ plateau, in ≈ τ·ln(|plateau − T| / 1 °C)", and in ladder mode the
  plateau of the next step. Below 30 % confidence the numbers are shown muted and not drawn on the timeline.
- To-temperature mode also gives:
  - **Plateau at your power** = T_amb + K·P.
  - **Time to target** = −τ·ln((plateau − target)/(plateau − T)), only when plateau > target > T.
    Otherwise it says "won't reach target at this power (levels off ≈ plateau)".
- The shadow loop never calls `set_setpoint`. A test enforces this, as for the existing `ThermalController`.
- The existing `ThermalController` and its hard-coded PI (KP 8 / KI 2) are **left unchanged and not exposed in the
  cockpit**: no "auto" button in this build. Retiring or replacing it comes after the shadow loop has proven
  itself.

### 3.4 Recorded every sample
- `telemetry.csv`, columns appended after the existing ones (`recording/recorder.py:29-57`), so old readers are
  unaffected: `setpoint_w` (the requested power; not recorded today), `part_roi, part_temp_c, temp_status,
  shadow_k, shadow_tau_s, shadow_conf, shadow_suggest_w, shadow_plateau_c, shadow_ttt_s, run_mode, target_c`.
  Unknown is blank, never 0.
- `roi_temps.csv`, a new **long-format sidecar**: `host_timestamp_ns, roi, mean_c` with one row per ROI per sample.
  It's long-format because the CSV header is fixed at run start (`recorder.py:122`) while ROI names change
  between FLIR sessions (§2). 11 ROIs at ~0.6 s ≈ 18 rows/s, the same order as `telemetry.csv`, written through
  the same off-thread writer (`tc-power-stale-fault-and-clear`).

### 3.5 API
- `GET /api/status → thermal` gains `watch`, `shadow`, `run_mode`.
- `POST /api/thermal/watch {names: [...]}` saves the watched ROIs.
- `GET /api/recordings/{run}/shadow?roi=<name>&target=<c>` re-runs the **same** pure estimator and shadow modules
  over a recording's `roi_temps.csv` + power (one implementation, no TypeScript port). 404 when the run has no
  ROI data.
- `POST /api/run-mode {mode, params}`, where mode is ladder | fixed | target | angle (angle is rejected as not
  available). Params: the ladder step list; the fixed W and duration; target, soak and ceiling (reusing the
  thermal plan store).
- Run mode is **display and bookkeeping only**. It never changes power by itself (D1).

### 3.6 Known issue to fix in this build
Auto-recording can stay open after the generator disconnects. 2026-10-06: run `20261006_164701` stayed active
14+ min with no new rows after the generator went offline. Fix: stop the auto-started recording when the
generator auto-disconnects (`tc-power-link-loss-disconnect`). A manually started recording is left alone.

## 4. Frontend: the cockpit (replaces the Closed-loop tab)

Layout as in mockup v4. Every element has a fixed position; alerts are pop-ups (D9).
- **Header row:** run mode chips · run name · network label (from the active map) · elapsed · energy (Wh).
- **Control strip (top, fixed):**
  - **Power dials:** the Dashboard's `Gauge` component, reused as is, ×4: Requested, Forward, Load, Reverse.
    Scales and zones come from the same sources as the Dashboard (`useOperator.ts:470-472`): 0–`power_limit_w`,
    caution/danger from Settings; Reverse 0–`max_reflected_w`, caution 50 %, danger 80 %.
  - **Setpoint:** a Manual | Temp loop switch.
    - Manual = the Dashboard's setpoint entry (number + Apply, −25/−5/+5/+25, keyboard nudges, ceiling clamp)
      plus RF on/off. Same handlers as `RfPowerPanel`, shared rather than copied.
    - Temp loop = target (from to-temperature mode) and loop power ceiling, plus the gate list and the Engage
      button. **Engage is locked in this build** (D12). Gates: to-temperature mode · control ROI live (stale →
      0 W) · confidence ≥ 60 % on this run · ≥ 1 core watched · core interlock armed (not built: always ✗).
    - Both views are the same height: switching moves nothing.
  - **Match:** large Tune/Load −/+ with readback, a reflected-% chip, and a one-line status (matched / close /
    retune by hand).
- **Timeline (below the strip):**
  - Temperature lane: the control ROI, watched ROIs (up to 4), and the target line (to-temperature) or the
    "levels off" line (ladder/fixed, only at ≥ 30 % confidence).
  - Power lane: your forward power (filled), the shadow suggestion (dashed; to-temperature only, ≥ 30 %
    confidence), reflected % (right axis), and retune ticks.
  - Scrolls the last 15 min live, with "Whole run" as an option.
- **Thermal column:** the control-ROI dropdown (live ROIs, or the run's recorded ROIs in replay); part temperature
  and rate; target and time to target; the shadow card by mode (§3.3) with K, τ and a confidence bar with its
  sentence; the temperature-status sentence (v0.16.0).
- **Run-mode column:**
  - Ladder: step list, current step, the next step's plateau, and a "Next step" button. It is an operator action.
  - Fixed: W and a timer, reusing the existing auto-shutoff timer.
  - Target: target, soak and ceiling.
- **Watched ROIs + drift column:** watched ROIs with temperature, rate and warn colour (thresholds set in Settings,
  default 45 °C and 3 °C/min, **provisional until set from run data**); the ROI picker (max 4, control ROI
  excluded); drift and travel (v0.13).

Pure logic (TDD, `lib/cockpit/*`):
- Timeline scales, windows and tick spacing.
- Loop gate evaluation (each gate's pass/fail and text).
- Confidence → sentence.
- Plateau and time-to-target text.
- Core level (ok/warn).
- Ladder step bookkeeping.
- Run-mode panel state.

## 5. What "never acts" means, concretely
- Nothing in this build calls `set_setpoint`, `enable_rf` or a cap command, except the operator's own clicks.
  "Next step" is an operator click. Engage is locked, and the backend rejects any request to engage the loop
  (409), so a UI bug can't unlock it.
- The shadow loop's suggestion is shown and recorded, never applied. Tests assert no actuator calls from the
  estimator, shadow loop, watch ROIs or run mode.

## 6. Replay tool (in-app, "Runs" view)

It is worth building only because it answers questions the live cockpit can't:
1. "Would the shadow loop have done better than me?" Your power vs its suggestion, across a whole recorded run.
2. "Where did it start to drift, and what did I do?" Every retune, cap command and RF on/off on the timeline,
   from `events.json`.
3. "What was the core doing when reflected rose?" Temperatures and reflected % on one time axis.

Scope:
- **Run list:** from `GET /api/recordings`, each tagged with whether it has ROI data.
- **ROI choice in replay:** the dropdown lists the ROIs recorded in that run. Picking another one re-runs the
  shadow loop on it through `GET /api/recordings/{run}/shadow` (§3.5).
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
- Any automatic power or cap action: Engage (v0.18), the core interlock (v0.18), and auto-retune (after the
  transformer-temperature interlock).
- The turntable and angle scheduling (selector shown disabled; pinned for discussion).
- Changing the FLIR tool.

## 8. Build order (each step TDD, then a browser check against the simulator)
1. Backend: watched ROIs and core rates, the recorder columns (`setpoint_w` + shadow columns), and the
   `roi_temps.csv` sidecar. Uses captured FLIR payload fixtures.
2. Backend: `plant_estimator`. Tests:
   - A synthetic first-order plant with power steps recovers K and τ within 10 %.
   - No estimate in the first 120 s of steady power. (Revised 2026-10-07: a clean synthetic first-order plant IS
     identifiable at steady power after ~240 s, conf 0.74; the real run's low early confidence is noise plus a
     non-first-order plant, so that is tested on real data instead: confidence < 0.3 at 8.3 min of the 10-02 run.)
   - **Real data:** the 10-02 FLIR trace, captured as a fixture, converges to K 0.35–0.65 °C/W and τ 100–250 s,
     with confidence ≥ 0.5 by the end.
3. Backend: `shadow_loop`. Tests: bounded and rate-limited output, never actuates, plateau and time-to-target
   maths. **θ check:** estimate the delay between a power step and the FLIR response on the real runs and
   replace the provisional 10 s.
4. Backend: run mode, the API (including the replay shadow endpoint and the locked engage → 409), and the
   auto-recording fix (§3.6).
5. Frontend: pure cockpit logic, then the v4 page (replacing Closed loop), reusing `Gauge` and the
   `RfPowerPanel` setpoint handlers.
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
