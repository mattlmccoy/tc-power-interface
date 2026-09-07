# Closed-loop thermal control — "trust it for a real fire" — Design

**Date:** 2026-09-07
**Status:** design (awaiting review) → implementation plan

**Goal:** Take the *existing* advisory/auto PI thermal loop and make it safe and trustworthy enough to
**drive real RF power** to hold a PA12 (nylon-12) part at 185 °C for the **first real hardware fire** —
without rebuilding the control law.

**Architecture:** Add a layered safety envelope and a deliberate advisory→armed→auto handoff around the
existing `ThermalController` + `plan_step` PI law. The temperature sensor path (FLIR control ROI) gains
staleness + sanity gating so a bad/frozen reading can never drive power. No new control theory.

**Tech stack:** Python 3.13 backend (FastAPI + the existing controller/thermal modules, pytest/ruff/mypy);
React/TS frontend (Experimental → "Thermal control (closed loop)" panel). FLIR temperature over the FLIR
tool's `/ws/frames` stream (localhost:8000).

---

## 1. What already exists (build on, don't rebuild)

- `control/thermal_loop.py`
  - `plan_step(...)` — pure control law: phases **RAMP → APPROACH → SOAK → COOL → DONE** (advance-only),
    PI power (`KP_W_PER_C = 8.0`, `KI_W_PER_C_S = 2.0`) with anti-windup, rate-limited by `max_step_w`,
    clamped to `min(loop_ceiling_w, max_forward_w)`.
  - `ThermalController` — `start/stop/arm/disarm/tick/snapshot`; `mode` ∈ {`advisory`, `auto`};
    `_may_drive(rf_on, faulted)` gates auto-drive (sim drives freely; real hardware requires `rf_on and
    armed`); **never enables RF**; disarms on fault or loss of RF; on an **invalid** temperature sample it
    already backs off to 0 W and does not drive.
  - `ThermalPlan` / `THERMAL_BOUNDS` — `target_c=185`, `soak_s`, `approach_band_c`, `loop_ceiling_w=200`,
    `max_step_w=25`, `done_below_c=50` (all tighten-only bounded; ceiling clamped to `max_forward_w`).
- `control/temperature.py` — `TemperatureSample(celsius, valid, ts)`; `TemperatureSource` protocol;
  `SimulatedThermalSource` (demo model); `RecordedTemperatureSource` (replay a real FLIR trace).
- `integration/flir_temperature.py` — `FlirTemperatureSource(url, stat="center_c")`: `apply_frame` (pure,
  unit-tested), `read`, `run` (live consumer). Reading is `valid=False` before the first frame.
- `integration/flir_client.py` — `parse_flir_header`, `control_temperature(message, stat)`,
  `stream_control_temperature`. Frame = `[4-byte len][JSON header][raw counts]`; header carries
  server-computed `center_c`, `mean_c`, `max_c` (over-range pixels excluded).
- `api/app.py` — `ThermalController` wired in `advisory` mode; `/api/thermal/{start,stop,arm,disarm,
  source,plan}`; `_stop_all_features()` halts the loop on disconnect/disarm/E-STOP; the global device
  **arm gate** (`controllable = connected && armed`); protection layer `control/safety.py` (reflected /
  over-temp trips force RF off) — always wins.
- Frontend `App.tsx` — Experimental → "Thermal control (closed loop)" panel; `api.thermalStart(mode)`,
  `thermalStop`, `thermalArm`, `thermalDisarm`, `thermalSource(type,url)`, `saveThermalPlan`.

## 2. Decisions (from brainstorming, 2026-09-07)

1. **Primary goal:** trust it for a real fire (safety-first), NOT control-quality tuning or the data
   pipeline (both deferred — see §7).
2. **Control signal = ROI `center_c`; hard-abort signal = ROI `max_c`.** Control smoothly on the center;
   protect against a local hot spot with a separate max-based abort.
3. **Abort ceiling = 250 °C** (configurable), target + 65. Chosen for headroom against thermal-lag
   overshoot; still below PA12 decomposition.
4. **Handoff = advisory dry-run, then promote.** Operator watches the loop advise (recommended vs actual)
   and presses **ARM LOOP** to hand it the setpoint. DISARM LOOP / E-STOP always instant.

## 3. Sensor trust (foundation)

- **Two ROI stats per frame:** `FlirTemperatureSource` reads BOTH `center_c` (control) and `max_c`
  (abort) from each frame header and exposes both. The `TemperatureSample` gains a `max_c: float | None`
  (or a parallel field) so the loop sees the hottest ROI pixel.
- **Staleness timeout (the gap found in design):** `read()` returns `valid=False` when the last frame is
  older than `STALE_S` (default **2.0 s**, configurable; sized to a few FLIR frame intervals). Today
  `apply_frame` sets `valid=True` and keeps the last value forever, so a frozen/dropped stream would keep
  driving on a stale temperature. With the timeout, the loop's existing "invalid → 0 W, don't drive"
  path halts driving on a frozen stream.
- **Sanity bounds:** a frame whose `center_c`/`max_c` is outside a plausible range (default **−20 … 600
  °C**) or jumps more than `MAX_JUMP_C` (default **60 °C**) from the previous *valid* sample is treated as
  `valid=False` (rejected, keep last-good but mark stale). One corrupt frame can never command power.

## 4. Safety envelope (layered, independent)

- **Hard max-temp abort:** when a *valid* `max_c ≥ abort_ceiling_c` (default 250, configurable via the
  thermal plan/limits), the loop: sets setpoint → 0, **disarms the loop**, and **latches an abort state**.
  - Latch clears only on an explicit operator **re-arm**, and re-arm is **blocked** while `max_c` is still
    above `abort_ceiling_c − HYST_C` (default HYST 10 °C) — no auto-resume into a hot part.
  - The abort is surfaced (banner/toast, red) with the reason and the temperature that tripped it.
- **Sensor-loss abort:** `valid=False` immediately → 0 W and don't drive (exists). If it stays invalid
  beyond `SENSOR_GRACE_S` (default 3 s) while armed, **disarm the loop** (so a dropout doesn't sit armed).
- **Existing protections unchanged and dominant:** `safety.py` reflected-power / generator over-temp trips
  force RF off (FAULT); the loop disarms on fault or loss of RF; the loop NEVER calls `enable_rf`. The
  global device ARM gate still applies (auto-drive needs the device armed AND rf_on on real hardware).
- **Overshoot:** the approach band already eases power before target; the 250 °C ceiling sits well above
  185 so normal lag overshoot will not nuisance-trip.

## 5. Advisory → ARM LOOP → auto (trust handoff)

States (loop): **stopped → advisory (running, not armed) → auto (running, armed)**; plus **aborted**
(latched). Transitions:
- Operator reaches a stable, matched manual operating point (device armed, RF on, some power).
- **Start (advisory):** loop runs, drives nothing; shows live **phase**, control temp (`center_c`),
  **ROI max** (`max_c`), the **setpoint it would command** vs the **actual** setpoint, and its reason.
- **ARM LOOP → auto:** loop drives `controller.set_setpoint` (bounded by loop-ceiling & max-forward,
  rate-limited by max_step). Requires device armed + rf_on on real hardware (existing `_may_drive`).
- **DISARM LOOP:** back to advisory (drives nothing), instant. **E-STOP / global disarm / RF-loss /
  fault:** stop the loop, instant (existing `_stop_all_features` + disarm-on-fault).
- **Aborted (latched):** from the max-temp or persistent-sensor-loss abort; requires manual re-arm, gated
  by hysteresis (§4).
- The advisory dry-run doubles as a **PI-gain sanity check**: if the sim-tuned gains (Kp 8, Ki 2)
  recommend something implausible against the real part, it is visible *before* arming; retuning is the
  separate deferred "control-quality" workstream (§7), not this change.

UI (Experimental → Thermal control): show phase, control temp, ROI max, recommended-W vs applied-W,
armed/abort state, and the ARM LOOP / DISARM LOOP buttons; abort shows a red banner with the trip temp.

## 6. Data contract to verify + logging

- **Step 0 — verify `max_c` on a live frame.** Documented in `flir_client` and the FLIR `api/frames.py`
  wire format, but the FLIR **camera was disconnected during design** (the stream emitted
  `{"type":"status","state":"disconnected"}`), so this is unverified against a real thermal frame.
  Verify before relying on abort-on-max. **Fallback:** if `max_c` is absent, add it to the FLIR tool's
  header, or compute the ROI max from the raw counts payload.
- **Logging:** ensure each recorded tick's thermal snapshot includes `control_temp_c` (center),
  `roi_max_c`, `phase`, `recommended_w`, `applied_w`, `armed`, and abort state, so every run has a full
  loop trace for later analysis (minimal add to the existing recorder wiring).

## 7. Out of scope (explicit — do NOT build here)

- Control-quality work: gain auto-tuning, plant/step-response identification, feedforward / lag
  compensation. (Deferred "better control quality" goal.)
- Multi-segment recipes / profile editor. (Single ramp→soak→cool only.)
- The full synchronized dissertation data pipeline / export. (Deferred "dissertation-grade data" goal.)

## 8. Testing / verification

- **TDD (pure/logic):** staleness→`valid=False`; sanity-bound rejection; max-temp abort zeros power +
  disarms + latches; re-arm blocked while hot (hysteresis); sensor-loss grace → disarm; advisory drives
  nothing; promote→auto drives; abort surfaces its reason.
- **End-to-end (sim/replay):** run the loop against `RecordedTemperatureSource` fed a **real FLIR trace**
  (e.g. the 2026-09-04 run) through advisory→auto→abort.
- **Live sanity (pre-fire gate):** one run against the live FLIR stream with the camera connected,
  confirming center & max read correctly and that a forced over-ceiling reading fires the abort — BEFORE
  auto-drive is trusted on a real part.

## 9. Open risks

- FLIR `max_c` contract unverified live (§6 step 0) — highest-priority check.
- PI gains are sim-tuned; the advisory dry-run is the mitigation (see them before arming), but a real
  run may reveal the need for the deferred control-quality workstream.
- Real-unit CXN protocol still unverified (see the read-only-probe / ARM gate flow) — closed-loop auto is
  gated behind a validated manual run first.
