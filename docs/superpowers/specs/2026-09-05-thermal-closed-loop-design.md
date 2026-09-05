# In-situ thermal closed loop — design spec

**Date:** 2026-09-05
**Status:** approved (brainstorm), pending spec review
**Repo:** `tc-power-interface`

## Goal

Add a thermal control loop that reads a control-ROI temperature, follows a target trajectory
(ramp → approach → soak → cool), and **drives the RF setpoint** to converge on it — auto in the
simulator (to demonstrate real convergence), and architected so the *same* loop can drive **real**
RF only under the operator's explicit, RF-already-on, closely-watched, tightly-bounded arm.

## Safety model (firm — dictated by the operator)

1. **The loop NEVER enables RF.** The human enables RF (hand on the switch).
2. The loop only adjusts the **setpoint**, always clamped to `[0, min(loop_ceiling_w, max_forward_w)]`
   and rate/step-limited. It never touches the RF-enable path.
3. **Protection is dominant.** A FAULT — or RF turning off for any reason — **disarms the loop
   instantly** (it reverts to advisory and stops driving).
4. **Simulator backend:** starting the loop may auto-drive the setpoint (convergence demo).
5. **Real (serial) backend:** auto-drive requires ALL of — RF is operator-enabled (`rf_on`), the
   operator has explicitly **armed** the loop, the tight loop bounds, and no fault. Anything missing
   → the loop is **advisory-only** (it computes and shows a recommended power but does not command
   it). Losing `rf_on`, the arm, or hitting a fault disarms.

## Non-goals

- Enabling RF automatically (never).
- AIT / match tracking (separate future work).
- A validated thermal model or real-hardware trust (the sim model is a demonstration only).

## Components

- **`control/temperature.py`** — `TemperatureSample` (`celsius`, `valid`, `ts`) and a
  `TemperatureSource` protocol (`read() -> TemperatureSample`). Two implementations:
  - `SimulatedThermalSource`: a first-order model coupled to the live RF power (below), so the loop
    converges in sim.
  - `FlirTemperatureSource`: wraps `integration/flir_client` (`/ws/frames`) — swappable, for FLIR's
    sim camera or a real FLIR later.
- **`control/thermal_loop.py`** —
  - `ThermalPlan` (`target_c`, `soak_s`, `approach_band_c`, `loop_ceiling_w`, `max_step_w`,
    `done_below_c`) with hard bounds (`loop_ceiling_w ≤ max_forward_w`, `target_c ≤ 300`).
  - `ThermalPhase` enum: `RAMP, APPROACH, SOAK, COOL, DONE`.
  - `plan_step(temp_c, phase, elapsed_soak_s, current_setpoint_w, plan) -> ThermalCommand`
    (`phase`, `target_power_w`, `reason`) — a **pure**, bounded proportional law + phase transitions,
    encoding the handoff's "reduce-before-target" lag handling. This is the TDD core.
  - `ThermalController` — runs `plan_step` against a `TemperatureSource` on a slow cadence, and in
    `auto` mode (when the arming gate allows) calls `controller.set_setpoint(bounded)`; otherwise
    emits an advisory recommendation only. Owns `mode` (`advisory|auto`), `armed`, and the source.
- Supersedes the coarse `control/thermal.py` `recommend()` (kept or folded in; the proportional
  `plan_step` is the loop's brain).

## Toy thermal model (sim only)

`dT/dt = k_heat · P_load − k_cool · (T − T_ambient)`, integrated per tick, with `P_load` read from
the T&C simulator's live load power (`forward − reflected`). Deterministic and convergent.
`SimulatedThermalSource` holds `T` and integrates using the controller's latest telemetry.

> **Data-contract note:** this is a *demonstration* model to exercise the control law, NOT a
> validated model of the real RF-heating system. Real thermal response must be characterized before
> the loop is trusted on hardware.

## Control law (pure, bounded)

- **RAMP** (`temp < target − approach_band`): raise the setpoint toward `loop_ceiling_w`, proportional
  to the error, capped by `max_step_w` per cycle.
- **APPROACH** (`target − approach_band ≤ temp < target`): ease off to a holding power to avoid
  overshoot (thermal lag) — reduce, don't push.
- **SOAK** (`temp ≥ target`): modulate around a holding power to hold `target_c` for `soak_s`.
- **COOL** (after soak): command setpoint → 0 (RF stays on but power drops); transition to **DONE**
  when `temp < done_below_c`.
- Every commanded setpoint is clamped to `[0, min(loop_ceiling_w, max_forward_w)]` and step-limited.

## API

- `GET/PUT /api/thermal/plan` — the `ThermalPlan`, persisted to `.thermal_plan.json`, hard-bounded.
- `POST /api/thermal/source` `{type: "sim"|"flir", url?}` — choose the temperature source.
- `POST /api/thermal/start` `{mode: "advisory"|"auto"}`, `POST /api/thermal/stop`.
- `POST /api/thermal/arm` / `POST /api/thermal/disarm` — real-backend gate (requires `rf_on`).
- Snapshot gains `thermal`: `{running, phase, mode, armed, source, control_temp_c, target_c,
  recommended_w, applied_w}`.

## UI

- **Settings:** thermal-plan config (target °C, soak s, loop ceiling W ≤ max forward, approach band,
  max step) with the same hard-bound + Save pattern as the safety limits.
- **Dashboard "Thermal control" panel:** source selector (sim model / FLIR URL), Start/Stop, mode
  (advisory/auto), an Arm control (shown for real, requires RF on), and a live readout of phase,
  control temp vs target, and recommended vs applied power, plus a small temp-vs-target trace.

## Testing

- **Pure `plan_step` (TDD):** each phase transition (RAMP→APPROACH→SOAK→COOL→DONE) on the right
  temp/time conditions; proportional + step-limit; reduce-before-target; clamp to
  `min(loop_ceiling_w, max_forward_w)`.
- **Sim convergence (integration):** `ThermalController(SimulatedThermalSource, auto)` drives the
  simulator until `temp` reaches `target ± tol`, phases progress, and the setpoint never exceeds the
  ceiling; then COOL → DONE.
- **Arming safety (TDD, fake controller):** serial-backend loop stays advisory unless `rf_on &&
  armed`; a fault or `rf_on=false` disarms; the loop never calls `enable_rf`; commanded setpoint ≤
  `min(loop_ceiling_w, max_forward_w)`.
- **FLIR source adapter:** a fake `/ws/frames` byte stream → temperature samples (reuses the tested
  `parse_flir_header`).
- **End-to-end (sim):** start the loop in auto, watch the UI converge to target and step through the
  phases; confirm a protection trip disarms it.
