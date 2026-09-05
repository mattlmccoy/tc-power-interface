# In-situ Thermal Closed Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [x]`.

**Goal:** A thermal control loop that reads a control-ROI temperature, follows a ramp→approach→soak→cool trajectory, and drives the RF **setpoint** (auto in sim; arm-gated for real) — never enabling RF, always bounded, protection-dominant.

**Architecture:** `TemperatureSource` (toy sim model + swappable FLIR) → pure `plan_step` control law → `ThermalController` that drives `controller.set_setpoint(bounded)` in auto mode when the arming gate allows, else advisory. Repo `tc-power-interface`, branch `feat/closed-loop`. Spec: `docs/superpowers/specs/2026-09-05-thermal-closed-loop-design.md`.

**Safety invariants (must hold in code + tests):** the loop never calls `enable_rf`; commanded setpoint ≤ `min(loop_ceiling_w, max_forward_w)`; a fault or `rf_on==False` disarms; real backend requires `rf_on && armed` to auto-drive.

---

## File Structure
- Create `backend/tc_power_interface/control/temperature.py` — `TemperatureSample`, `TemperatureSource` protocol, `SimulatedThermalSource`.
- Create `backend/tc_power_interface/control/thermal_loop.py` — `ThermalPlan`, `ThermalPhase`, `plan_step`, `ThermalController`.
- Create `backend/tc_power_interface/control/thermal_store.py` — persist `.thermal_plan.json`.
- Create `backend/tc_power_interface/integration/flir_temperature.py` — `FlirTemperatureSource`.
- Modify `backend/tc_power_interface/api/app.py` — thermal routes + snapshot block + wire loop.
- Tests: `test_temperature.py`, `test_thermal_loop.py`, `test_thermal_controller.py`, `test_thermal_store.py`, `test_api_thermal.py`, `test_flir_temperature.py`.
- Frontend: `src/lib/telemetry.ts` (+thermal types), `src/lib/api.ts` (+thermal methods), `src/App.tsx` (Thermal-control panel + plan config in Settings).

---

## Task 1: `TemperatureSource` + toy `SimulatedThermalSource`

**Files:** Create `control/temperature.py`; Test `tests/test_temperature.py`.

- [x] **Step 1: Failing test**

```python
from tc_power_interface.control.temperature import SimulatedThermalSource


def test_starts_at_ambient():
    src = SimulatedThermalSource(ambient_c=25.0)
    s = src.read()
    assert s.valid is True
    assert s.celsius == 25.0


def test_heats_toward_a_power_dependent_steady_state():
    # k_heat/k_cool = 1.25 -> steady T = ambient + 1.25 * P.  At 100 W: ~150 C.
    src = SimulatedThermalSource(ambient_c=25.0, k_heat=0.125, k_cool=0.1)
    for _ in range(400):
        src.step(load_w=100.0, dt_s=0.1)
    assert 145.0 < src.read().celsius < 155.0


def test_cools_toward_ambient_with_no_power():
    src = SimulatedThermalSource(ambient_c=25.0, k_heat=0.125, k_cool=0.1)
    for _ in range(200):
        src.step(load_w=100.0, dt_s=0.1)  # heat up
    for _ in range(600):
        src.step(load_w=0.0, dt_s=0.1)  # then cool
    assert src.read().celsius < 40.0
```

- [x] **Step 2: Run — RED** (`cd backend && uv run pytest tests/test_temperature.py -q`).

- [x] **Step 3: Implement**

```python
# backend/tc_power_interface/control/temperature.py
"""Control-ROI temperature sources for the thermal loop.

`SimulatedThermalSource` is a first-order power->temperature DEMONSTRATION model (not a validated
model of the real system); it lets the closed loop converge in the simulator. The FLIR source lives
in integration/flir_temperature.py and satisfies the same protocol.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class TemperatureSample:
    celsius: float
    valid: bool
    ts: float


class TemperatureSource(Protocol):
    def read(self) -> TemperatureSample: ...


class SimulatedThermalSource:
    """dT/dt = k_heat * P_load - k_cool * (T - ambient), integrated by explicit Euler."""

    def __init__(self, *, ambient_c: float = 25.0, k_heat: float = 0.125,
                 k_cool: float = 0.1) -> None:
        self.ambient_c = ambient_c
        self.k_heat = k_heat
        self.k_cool = k_cool
        self._t = ambient_c

    def step(self, load_w: float, dt_s: float) -> None:
        self._t += (self.k_heat * load_w - self.k_cool * (self._t - self.ambient_c)) * dt_s

    def read(self) -> TemperatureSample:
        return TemperatureSample(celsius=self._t, valid=True, ts=time.time())
```

- [x] **Step 4: Run — GREEN.** **Step 5: Commit** (`feat(thermal): temperature source protocol + toy sim thermal model`).

## Task 2: Pure control law `plan_step` + `ThermalPlan`/`ThermalPhase`

**Files:** Create `control/thermal_loop.py` (this task adds the plan + pure step); Test `tests/test_thermal_loop.py`.

- [x] **Step 1: Failing test**

```python
from tc_power_interface.control.thermal_loop import (
    THERMAL_BOUNDS,
    ThermalCommand,
    ThermalPhase,
    ThermalPlan,
    plan_step,
)

PLAN = ThermalPlan(target_c=150, soak_s=30, approach_band_c=15, loop_ceiling_w=200,
                   max_step_w=25, done_below_c=50)


def test_bounds_clamp_plan():
    p = ThermalPlan.bounded(target_c=9999, soak_s=30, approach_band_c=15,
                            loop_ceiling_w=9999, max_step_w=9999, done_below_c=50,
                            max_forward_w=350)
    assert p.target_c == THERMAL_BOUNDS["target_c"][1]  # 300
    assert p.loop_ceiling_w == 350  # clamped to max_forward_w
    assert p.max_step_w == THERMAL_BOUNDS["max_step_w"][1]  # 50


def test_ramp_when_far_below_steps_up_capped():
    cmd = plan_step(temp_c=25, phase=ThermalPhase.RAMP, elapsed_soak_s=0,
                    current_setpoint_w=0, plan=PLAN)
    assert cmd.phase == ThermalPhase.RAMP
    assert 0 < cmd.target_power_w <= PLAN.max_step_w  # steps up from 0 by <= max_step


def test_never_exceeds_ceiling():
    cmd = plan_step(temp_c=25, phase=ThermalPhase.RAMP, elapsed_soak_s=0,
                    current_setpoint_w=195, plan=PLAN)
    assert cmd.target_power_w <= PLAN.loop_ceiling_w


def test_approach_phase_eases_off_below_target():
    cmd = plan_step(temp_c=140, phase=ThermalPhase.RAMP, elapsed_soak_s=0,
                    current_setpoint_w=200, plan=PLAN)
    assert cmd.phase == ThermalPhase.APPROACH
    assert cmd.target_power_w < 200  # reduce to coast up (lag)


def test_soak_then_cool_after_soak_time():
    at = plan_step(temp_c=151, phase=ThermalPhase.APPROACH, elapsed_soak_s=0,
                   current_setpoint_w=80, plan=PLAN)
    assert at.phase == ThermalPhase.SOAK
    done = plan_step(temp_c=151, phase=ThermalPhase.SOAK, elapsed_soak_s=31,
                     current_setpoint_w=80, plan=PLAN)
    assert done.phase == ThermalPhase.COOL
    assert done.target_power_w == 0


def test_cool_to_done_below_threshold():
    cmd = plan_step(temp_c=40, phase=ThermalPhase.COOL, elapsed_soak_s=0,
                    current_setpoint_w=0, plan=PLAN)
    assert cmd.phase == ThermalPhase.DONE
    assert cmd.target_power_w == 0
```

- [x] **Step 2: Run — RED.**

- [x] **Step 3: Implement** in `control/thermal_loop.py`

```python
from __future__ import annotations

import enum
from dataclasses import dataclass

#: Hard bounds for the thermal plan (tighten-only; loop_ceiling_w also clamped to max_forward_w).
THERMAL_BOUNDS: dict[str, tuple[float, float]] = {
    "target_c": (30, 300),
    "soak_s": (0, 3600),
    "approach_band_c": (1, 60),
    "loop_ceiling_w": (0, 400),
    "max_step_w": (1, 50),
    "done_below_c": (25, 200),
}
#: Proportional gain (W per deg C of error) for the ramp/hold law.
KP_W_PER_C = 8.0


class ThermalPhase(enum.Enum):
    RAMP = "ramp"
    APPROACH = "approach"
    SOAK = "soak"
    COOL = "cool"
    DONE = "done"


@dataclass(frozen=True)
class ThermalPlan:
    target_c: float = 150.0
    soak_s: float = 30.0
    approach_band_c: float = 15.0
    loop_ceiling_w: int = 200
    max_step_w: int = 25
    done_below_c: float = 50.0

    @classmethod
    def bounded(cls, *, target_c: float, soak_s: float, approach_band_c: float,
                loop_ceiling_w: float, max_step_w: float, done_below_c: float,
                max_forward_w: int) -> "ThermalPlan":
        def clamp(name: str, v: float) -> float:
            lo, hi = THERMAL_BOUNDS[name]
            return max(lo, min(v, hi))
        return cls(
            target_c=clamp("target_c", target_c),
            soak_s=clamp("soak_s", soak_s),
            approach_band_c=clamp("approach_band_c", approach_band_c),
            loop_ceiling_w=int(min(clamp("loop_ceiling_w", loop_ceiling_w), max_forward_w)),
            max_step_w=int(clamp("max_step_w", max_step_w)),
            done_below_c=clamp("done_below_c", done_below_c),
        )


@dataclass(frozen=True)
class ThermalCommand:
    phase: ThermalPhase
    target_power_w: float
    reason: str


def plan_step(*, temp_c: float, phase: ThermalPhase, elapsed_soak_s: float,
              current_setpoint_w: float, plan: ThermalPlan) -> ThermalCommand:
    """Pure control law: new phase + a bounded target setpoint. The caller applies it."""
    # Terminal / cooling phases first.
    if phase is ThermalPhase.DONE:
        return ThermalCommand(ThermalPhase.DONE, 0.0, "done")
    if phase is ThermalPhase.COOL:
        if temp_c < plan.done_below_c:
            return ThermalCommand(ThermalPhase.DONE, 0.0, "cooled below done threshold")
        return ThermalCommand(ThermalPhase.COOL, 0.0, "cooling")
    if phase is ThermalPhase.SOAK and elapsed_soak_s >= plan.soak_s:
        return ThermalCommand(ThermalPhase.COOL, 0.0, "soak complete -> cool")

    # Proportional desired power, clamped to the ceiling.
    desired = max(0.0, min(KP_W_PER_C * (plan.target_c - temp_c), float(plan.loop_ceiling_w)))
    # Step-limit around the current setpoint.
    target = max(current_setpoint_w - plan.max_step_w,
                 min(desired, current_setpoint_w + plan.max_step_w))
    target = max(0.0, min(target, float(plan.loop_ceiling_w)))

    if temp_c >= plan.target_c:
        return ThermalCommand(ThermalPhase.SOAK, target, "soaking near target")
    if temp_c >= plan.target_c - plan.approach_band_c:
        return ThermalCommand(ThermalPhase.APPROACH, target, "approaching target; easing off")
    return ThermalCommand(ThermalPhase.RAMP, target, "ramping to target")
```

- [x] **Step 4: Run — GREEN.** **Step 5: Commit** (`feat(thermal): pure ramp/approach/soak/cool control law`).

## Task 3: `ThermalController` (arming gate, drives setpoint) — safety core

**Files:** add to `control/thermal_loop.py`; Test `tests/test_thermal_controller.py`.

`ThermalController` wraps the main `Controller` + a `TemperatureSource`. Each `tick(dt_s)`: read temp,
step the sim source (if sim), compute `plan_step`, track soak time + phase, and — only if allowed —
call `controller.set_setpoint(target)`. Otherwise store a recommendation.

**Arming gate `_may_drive()`** returns True iff: `mode=="auto"` AND controller not FAULT AND
`(backend=="simulated")` OR `(rf_on AND armed)`. It NEVER calls `enable_rf`.

- [x] **Step 1: Failing tests**

```python
from tc_power_interface.control.thermal_loop import ThermalController, ThermalPlan, ThermalPhase
from tc_power_interface.control.temperature import SimulatedThermalSource


class FakeController:
    def __init__(self, *, backend="simulated", rf_on=True, faulted=False, forward_w=0.0):
        self.backend = backend
        self._rf_on = rf_on
        self._faulted = faulted
        self.forward_w = forward_w
        self.enable_calls = 0
        self.last_setpoint = None
        from tc_power_interface.control.safety import SafetyLimits
        self.limits = SafetyLimits(max_forward_w=350)

    def set_setpoint(self, w):
        self.last_setpoint = w
        self.forward_w = w
        return w

    def enable_rf(self):
        self.enable_calls += 1

    def snapshot(self):
        return {"state": "fault" if self._faulted else "connected",
                "telemetry": {"rf_on": self._rf_on, "forward_w": self.forward_w,
                              "reverse_w": self.forward_w * 0.01,
                              "load_w": self.forward_w * 0.99}}


def _tc(fake, **kw):
    return ThermalController(fake, SimulatedThermalSource(), plan=ThermalPlan(), **kw)


def test_never_enables_rf():
    fake = FakeController()
    tc = _tc(fake, mode="auto")
    tc.start()
    for _ in range(50):
        tc.tick(0.1)
    assert fake.enable_calls == 0


def test_auto_drives_setpoint_in_sim():
    fake = FakeController(backend="simulated", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    tc.tick(0.1)
    assert fake.last_setpoint is not None  # it drove the setpoint


def test_setpoint_never_exceeds_ceiling_or_max_forward():
    fake = FakeController()
    tc = _tc(fake, mode="auto")
    tc.start()
    for _ in range(200):
        tc.tick(0.1)
    assert fake.last_setpoint is None or fake.last_setpoint <= ThermalPlan().loop_ceiling_w


def test_real_backend_advisory_until_armed():
    fake = FakeController(backend="serial", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    tc.tick(0.1)
    assert fake.last_setpoint is None  # not armed -> advisory only
    tc.arm()
    tc.tick(0.1)
    assert fake.last_setpoint is not None  # armed + rf_on -> drives


def test_fault_disarms_and_stops_driving():
    fake = FakeController(backend="serial", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start(); tc.arm()
    fake._faulted = True
    tc.tick(0.1)
    assert tc.armed is False
    assert fake.last_setpoint is None


def test_converges_to_target_in_sim():
    fake = FakeController(backend="simulated", rf_on=True)
    tc = ThermalController(fake, SimulatedThermalSource(k_heat=0.125, k_cool=0.1),
                           plan=ThermalPlan(target_c=150, soak_s=1), mode="auto")
    tc.start()
    for _ in range(2000):
        tc.tick(0.1)
    assert 140 < tc.control_temp_c < 160 or tc.phase in (ThermalPhase.SOAK, ThermalPhase.COOL,
                                                          ThermalPhase.DONE)
```

- [x] **Step 2: Run — RED.**

- [x] **Step 3: Implement** `ThermalController` in `control/thermal_loop.py`

```python
import time as _time
from typing import Any


class ThermalController:
    def __init__(self, controller: Any, source: Any, *, plan: ThermalPlan,
                 mode: str = "advisory") -> None:
        self.controller = controller
        self.source = source
        self.plan = plan
        self.mode = mode
        self.running = False
        self.armed = False
        self.phase = ThermalPhase.RAMP
        self.control_temp_c = 0.0
        self.recommended_w = 0.0
        self.applied_w: float | None = None
        self.reason = ""
        self._soak_start: float | None = None

    def start(self) -> None:
        self.running = True
        self.phase = ThermalPhase.RAMP
        self._soak_start = None

    def stop(self) -> None:
        self.running = False
        self.armed = False

    def arm(self) -> None:
        self.armed = True

    def disarm(self) -> None:
        self.armed = False

    def _backend(self) -> str:
        return getattr(self.controller, "backend", "simulated")

    def _may_drive(self, rf_on: bool, faulted: bool) -> bool:
        if self.mode != "auto" or faulted:
            return False
        if self._backend() == "simulated":
            return True
        return bool(rf_on and self.armed)

    def tick(self, dt_s: float) -> None:
        if not self.running:
            return
        snap = self.controller.snapshot()
        tel = snap.get("telemetry") or {}
        rf_on = bool(tel.get("rf_on"))
        faulted = snap.get("state") == "fault"
        if faulted or not rf_on:
            self.armed = False  # lose RF or fault -> disarm
        # advance the sim thermal model from live load power (only the sim source has .step)
        if hasattr(self.source, "step"):
            self.source.step(load_w=float(tel.get("load_w", 0.0)), dt_s=dt_s)
        self.control_temp_c = self.source.read().celsius

        elapsed = 0.0 if self._soak_start is None else (_time.monotonic() - self._soak_start)
        current = float(tel.get("forward_w", 0.0))
        cmd = plan_step(temp_c=self.control_temp_c, phase=self.phase, elapsed_soak_s=elapsed,
                        current_setpoint_w=current, plan=self.plan)
        if cmd.phase is ThermalPhase.SOAK and self.phase is not ThermalPhase.SOAK:
            self._soak_start = _time.monotonic()
        self.phase = cmd.phase
        self.recommended_w = cmd.target_power_w
        self.reason = cmd.reason

        if self._may_drive(rf_on, faulted):
            self.applied_w = self.controller.set_setpoint(int(cmd.target_power_w))
        else:
            self.applied_w = None
```

- [x] **Step 4: Run — GREEN.** **Step 5: Commit** (`feat(thermal): ThermalController with arming gate (never enables RF)`).

## Task 4: persistence + API + snapshot + wire loop

**Files:** Create `control/thermal_store.py`; Modify `api/app.py`; Test `tests/test_thermal_store.py`, `tests/test_api_thermal.py`.

- [x] `thermal_store.py`: `load_plan(root, max_forward_w)` / `save_plan(root, plan)` for `.thermal_plan.json` (mirror `safety_store.py`, clamp via `ThermalPlan.bounded`). TDD (roundtrip + clamp).
- [x] In `create_app` lifespan: build `ThermalController(controller, SimulatedThermalSource(), plan=load_plan(experiments_root, active_limits.max_forward_w), mode="advisory")`; set `controller.backend = backend` (so the gate can read it — add a `backend` attribute on `Controller`, defaulting "simulated", set in `create_app`); register a listener or a background tick (drive `thermal.tick(poll_interval_s)` from the controller poll via `controller.add_listener` — the listener gets the snapshot each poll; call `thermal.tick(poll_interval_s)` there). Store `app.state.thermal`.
- [x] Routes: `GET/PUT /api/thermal/plan` (bounded, persisted, `thermal.plan = new`); `POST /api/thermal/start` `{mode}`; `POST /api/thermal/stop`; `POST /api/thermal/arm`; `POST /api/thermal/disarm`; `POST /api/thermal/source` `{type,url?}` (sim -> `SimulatedThermalSource`, flir -> `FlirTemperatureSource(url)`).
- [x] Snapshot: add `thermal` block `{running, phase, mode, armed, source, control_temp_c, target_c, recommended_w, applied_w}` (from `app.state.thermal`), merged into `_status_payload()`.
- [x] `test_api_thermal.py` (TestClient, simulated): GET plan defaults + bounds; PUT clamps loop_ceiling_w to max_forward_w; start(auto) + several status polls show `phase` advancing and `applied_w` set (sim auto-drives); arm/disarm; source switch to sim ok.
- [x] TDD RED→GREEN, full gate (`uv run pytest -q && ruff && mypy`). Commit (`feat(api): thermal plan + start/stop/arm/source + snapshot`).

## Task 5: `FlirTemperatureSource`

**Files:** Create `integration/flir_temperature.py`; Test `tests/test_flir_temperature.py`.

- [x] A source that holds the latest temperature updated from a FLIR `/ws/frames` stream via
  `integration/flir_client` (`parse_flir_header`/`control_temperature`), exposing `read()`.
  Unit-test the "apply a frame -> read() returns that stat" path with a synthetic frame (reuse the
  helper from `tests/test_flir_integration.py`); the live socket is integration-only. Commit
  (`feat(thermal): FLIR temperature source adapter`).

## Task 6: Frontend types + API client

- [x] `telemetry.ts`: add `ThermalStatus` (`running, phase, mode, armed, source, control_temp_c,
  target_c, recommended_w, applied_w`) and extend `Status.controller` (or the snapshot type) with an
  optional `thermal`; add `ThermalPlanForm`/`ThermalPlanStatus` (with `bounds`).
- [x] `api.ts`: `thermalPlan()`, `saveThermalPlan(v)`, `thermalStart(mode)`, `thermalStop()`,
  `thermalArm()`, `thermalDisarm()`, `thermalSource(type,url?)`.
- [x] `npm test` green; commit (`feat(ui): thermal API types + client`).

## Task 7: Thermal-control UI (browser-verified)

- [x] Dashboard: a **Thermal control** panel — source selector (sim / FLIR URL), Start/Stop, mode
  (advisory/auto), an **Arm** button (enabled only when `rf_on`, shown when backend real / always
  usable), and a live readout: phase, control temp vs `target_c`, recommended vs applied W. Optional
  small temp-vs-target trace reusing `TimePlot`.
- [x] Settings: a **Thermal plan** form (target °C, soak s, loop ceiling W, approach band, max step)
  with hard-bound hints + Save (same pattern as safety limits).
- [x] `npm run build` + `npm test` green; commit (`feat(ui): thermal-control panel + plan settings`).

## Task 8: End-to-end (sim convergence)

- [x] `npm run build`; `uv run tcp-serve` (:8010). `curl -X POST /api/rf/enable` (operator enables
  RF). `curl -X POST /api/thermal/start -d '{"mode":"auto"}'`. Poll `/api/status` and watch
  `controller.thermal.phase` go RAMP→APPROACH→SOAK→COOL→DONE and `control_temp_c` approach
  `target_c`; confirm `applied_w` never exceeds the loop ceiling. Then trip protection (tight
  `max_reflected_w`) and confirm the loop **disarms** and stops driving. Screenshot the UI. Record in
  `plan/notes.md`.

---

## Self-review
- **Spec coverage:** temp sources both (T1 sim, T5 FLIR); pure control law (T2); ThermalController auto-drive + arming gate + never-enable-RF + fault-disarm + clamp (T3); persistence + API + snapshot (T4); UI (T6/T7); sim convergence + disarm-on-fault e2e (T8). ✅
- **Safety invariants tested:** `test_never_enables_rf`, `test_real_backend_advisory_until_armed`, `test_fault_disarms_and_stops_driving`, `test_setpoint_never_exceeds_ceiling_or_max_forward` (T3). ✅
- **Type consistency:** `ThermalPlan.bounded(...)`, `THERMAL_BOUNDS`, `plan_step(*, temp_c, phase, elapsed_soak_s, current_setpoint_w, plan)`, `ThermalCommand{phase,target_power_w,reason}`, `ThermalController.{start,stop,arm,disarm,tick,phase,control_temp_c,recommended_w,applied_w,mode,armed}` used consistently across tasks. Requires adding a `backend` attribute to `Controller` (set in `create_app`) — noted in T4.
