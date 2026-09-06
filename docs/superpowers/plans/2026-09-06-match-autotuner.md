# Software Matching Auto-Tuner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or
> executing-plans). Red-green TDD for every backend step; the UI panel is browser-verified on :8010.
> Steps use `- [ ]`.

**Goal:** A model-informed perturb-and-observe control loop that keeps the RF matching network tuned —
trimming the tune/load caps to minimize **reverse power** as the load drifts during sintering — using
only the generator's reverse-power reading (no in-run VNA). It never enables RF, runs only in manual
mode, makes small bounded cap moves, and is arm-gated on real hardware.

**Architecture:** Mirror the thermal loop (`control/thermal_loop.py`) and power ramp
(`control/power_ramp.py`): a pure step law + a `MatchTuner` controller that `tick()`s from the poll
listener, reads reverse power from telemetry, and drives `set_tune_capacity`/`set_load_capacity` only
when armed. A cap-dependent reflection well is added to the simulator so reverse power actually
responds to the caps. Config/status over REST; a Match-tuner panel in the matching-network area.

**Tech stack:** Python 3.13 (uv) / FastAPI / pytest / ruff / mypy; React 18 + Vite + TS, `node --test`.

## Status of the design spec's sub-projects
- **S1 (manual-mode lock + power-on-order guidance): DONE** — codec emits only `TM 02`; controller
  forces manual on connect; UI shows the locked badge + the disconnected startup-order banner.
- **S2 (finer cap resolution): DONE** — caps write/read at 0.1% (`cmd_tune_capacity`/`cmd_load_capacity`
  encode `%×10`), UI steps 0.1%. *(Leftover, Task 6 below: show the physical 0–5 value next to %.)*
- **S3 (sim reflection model): THIS PLAN, Task 1.**
- **S4 (MatchTuner loop + API + UI): THIS PLAN, Tasks 2–5.**

## Grounding facts (the data contract — from the spec + measured bench data)
- **TUNE is hyper-sensitive (narrow well); LOAD is broad.** Shape is consistent across hardware; the
  absolute optimum (T,L) is NOT ⇒ the loop is **relative** (chase the local minimum, never a fixed
  position).
- **Magnitude only, no phase, no in-run VNA** ⇒ resolve direction by **dithering** on reverse power.
- **Mismatch is large** (Matt saw ~89 W reverse at 100 W forward) ⇒ the sim well ceiling ≈ 0.9.
- Current sim (`device/simulated.py:69` `_power_watts`): `rev = fwd * self._reflected_fraction` with a
  **fixed 0.01** — ignores the caps. Task 1 replaces this.
- Caps are 0–100 % at 0.1 % resolution (verified in `protocol/codec.py`); the tuner works in %.
- **HARD SAFETY (unchanged):** never enable RF; never engage the built-in auto-tuner; only drive while
  `manual_mode && rf_on && armed`; clamp every cap to `[min,max]`; the over-reverse protection trip
  fires independently; real-hardware CXN is unverified (arm-gated, operator-watched).

---

## Task 1 (S3): Simulator reflection well — reverse power responds to the caps

**Files:**
- Create `backend/tc_power_interface/device/reflection.py`
- Create `backend/tests/test_reflection.py`
- Modify `backend/tc_power_interface/device/simulated.py` (hold `t_opt`/`l_opt`, drift, use the well)
- Modify `backend/tests/test_device.py` (if a fixed-0.01 assumption is asserted anywhere)

- [ ] **Step 1 — RED: the well shape.** `backend/tests/test_reflection.py`:

```python
"""The simulator's reverse-power well: a sharp-in-tune, broad-in-load minimum at (t_opt, l_opt)."""

from tc_power_interface.device.reflection import CEILING, FLOOR, reflected_fraction


def test_minimum_at_optimum():
    assert reflected_fraction(50, 50, 50, 50) == FLOOR


def test_far_from_optimum_approaches_ceiling():
    r = reflected_fraction(0, 0, 90, 90)
    assert r > 0.8
    assert r <= CEILING


def test_tune_is_sharper_than_load():
    # An equal cap offset costs far more reverse power in tune than in load.
    dt = reflected_fraction(55, 50, 50, 50)  # +5% tune
    dl = reflected_fraction(50, 55, 50, 50)  # +5% load
    assert dt > dl


def test_monotonic_in_each_axis_moving_away():
    base = reflected_fraction(50, 50, 50, 50)
    assert reflected_fraction(52, 50, 50, 50) > base
    assert reflected_fraction(50, 60, 50, 50) > base
```

- [ ] **Step 2 — Run it, watch it fail** (module missing):
`cd backend && uv run pytest tests/test_reflection.py -q` → FAIL (ModuleNotFoundError).

- [ ] **Step 3 — GREEN: implement the well.** `backend/tc_power_interface/device/reflection.py`:

```python
"""Relative reverse-power well for the simulator: a Gaussian minimum at (t_opt, l_opt), SHARP in
tune and BROAD in load, matching the bench NanoVNA sensitivities (tune ±small swings the match hard;
load is forgiving). Calibrated in *shape*, not absolute position — a demonstration model."""

from __future__ import annotations

import math

FLOOR = 0.01  # reverse fraction at a perfect match
CEILING = 0.9  # reverse fraction far from the match (Matt saw ~89% mismatch on the bench)
TUNE_WIDTH = 2.0  # % — narrow well in tune (hyper-sensitive)
LOAD_WIDTH = 22.0  # % — broad well in load (forgiving)


def reflected_fraction(tune: float, load: float, t_opt: float, l_opt: float) -> float:
    """Reverse-power fraction (FLOOR..CEILING) for caps at (tune, load) vs the optimum (t_opt, l_opt)."""
    dt = (tune - t_opt) / TUNE_WIDTH
    dl = (load - l_opt) / LOAD_WIDTH
    well = math.exp(-0.5 * (dt * dt + dl * dl))  # 1 at the optimum, → 0 far away
    return FLOOR + (CEILING - FLOOR) * (1.0 - well)
```

- [ ] **Step 4 — Run it, watch it pass:** `uv run pytest tests/test_reflection.py -q` → PASS.

- [ ] **Step 5 — Wire the well + a drifting optimum into the sim.** In `device/simulated.py`
`__init__` add movable optima and drift state (start detuned so the tuner has real work):

```python
        # Reflection well: caps start at 50/50; the optimum is offset so the tuner must search,
        # and drifts slowly while RF is on to emulate the load changing during sinter.
        self.t_opt = 62.0
        self.l_opt = 40.0
        self._t_drift = 0.004  # %/read while RF on (tune optimum walks slowly)
        self._l_drift = 0.02   # %/read while RF on (load optimum walks faster)
```

Replace `_power_watts` (currently `rev = fwd * self._reflected_fraction`) with the well + drift:

```python
    def _power_watts(self) -> tuple[float, float, float]:
        if not (self.control_granted and self.rf_on):
            return (0.0, 0.0, 0.0)
        # Drift the optimum while RF is on (bounded so it stays reachable), then evaluate the well.
        self.t_opt = min(90.0, max(10.0, self.t_opt + self._t_drift))
        self.l_opt = min(90.0, max(10.0, self.l_opt + self._l_drift))
        frac = reflected_fraction(self.tune_capacity, self.load_capacity, self.t_opt, self.l_opt)
        fwd = float(self.setpoint_w)
        rev = fwd * frac
        return (fwd, rev, fwd - rev)
```

Add `from tc_power_interface.device.reflection import reflected_fraction` to the imports. Keep the
`reflected_fraction` __init__ arg (unused now) or drop it — if dropped, grep for callers first.

- [ ] **Step 6 — Run the full backend suite:** `uv run pytest -q` and `uv run ruff check` +
`uv run mypy tc_power_interface/`. Fix any test that assumed a fixed 1% reverse. Expected: green.

- [ ] **Step 7 — Commit:** `feat(sim): cap-dependent reverse-power well (sharp tune / broad load, drifting optimum)`.

---

## Task 2 (S4a): The pure perturb-and-observe step law

**Files:** Create `backend/tc_power_interface/control/match_tuner.py` (law only this task);
create `backend/tests/test_match_tuner_law.py`.

- [ ] **Step 1 — RED:** `backend/tests/test_match_tuner_law.py`:

```python
"""Dither law: with magnitude-only feedback, keep a cap's direction while reverse power falls, and
reverse it when reverse power rises."""

from tc_power_interface.control.match_tuner import observe


def test_keeps_direction_when_improving():
    # reverse power fell by more than eps -> keep going the same way
    assert observe(prev=0.30, curr=0.25, direction=+1, eps=0.005) == (+1, True)


def test_reverses_direction_when_worse():
    assert observe(prev=0.25, curr=0.30, direction=+1, eps=0.005) == (-1, False)


def test_reverses_when_flat_within_eps():
    # no real improvement -> treat as not-improving and reverse to probe the other way
    assert observe(prev=0.2500, curr=0.2490, direction=-1, eps=0.005) == (+1, False)
```

- [ ] **Step 2 — Run it, watch it fail** (module missing).

- [ ] **Step 3 — GREEN:** put the law in `control/match_tuner.py`:

```python
"""Software matching auto-tuner: model-informed perturb-and-observe on REVERSE power.

Safety: never enables RF; drives caps only while armed + RF on + manual mode; clamps every cap to
[min,max]; holds/backs off when reverse power rises or fails to improve; disarms on fault or RF-off.
The generator's built-in auto-tuner is never engaged (that path does not exist in the codec)."""

from __future__ import annotations


def observe(*, prev: float, curr: float, direction: int, eps: float) -> tuple[int, bool]:
    """Given reverse power before/after a move in ``direction``, return (next_direction, improved).

    Improved (fell by > eps) -> keep direction. Otherwise reverse to probe the other way."""
    improved = curr < prev - eps
    return (direction if improved else -direction, improved)
```

- [ ] **Step 4 — Run it, watch it pass.**
- [ ] **Step 5 — Commit:** `feat(tuner): perturb-and-observe dither law`.

---

## Task 3 (S4b): The MatchTuner controller (interleaved coordinate descent + safety)

**Files:** Modify `control/match_tuner.py` (add plan + controller); create
`backend/tests/test_match_tuner.py`.

**Design:** interleaved coordinate descent honoring tune-coarse / load-fine. Each `tick`: read reverse
power; update the just-moved axis's direction via `observe`; then, if searching, move the *next* axis
(alternating tune/load, tune weighted 2:1) by `dir*step` clamped to bounds — applying it only in
`auto` mode (advisory just records the recommendation). Track `best`; after `settle_hold` ticks with no
improvement → `holding` (monitor only); if reverse rises `> best + resume_delta` → resume searching
(drift). A `guard` fraction: if reverse exceeds it, undo the last move and hold briefly.

- [ ] **Step 1 — RED:** `backend/tests/test_match_tuner.py`:

```python
from tc_power_interface.control.match_tuner import MatchTuner, MatchTunerPlan
from tc_power_interface.device.reflection import FLOOR, reflected_fraction


class FakeController:
    """Drives caps against the sim well; reverse power = well(tune,load) at a fixed optimum."""

    def __init__(self, tune=50.0, load=50.0, t_opt=62.0, l_opt=40.0):
        self.tune = tune
        self.load = load
        self.t_opt = t_opt
        self.l_opt = l_opt
        self.rf_enabled_calls = 0

    def set_tune_capacity(self, p):
        self.tune = max(0.0, min(100.0, p))

    def set_load_capacity(self, p):
        self.load = max(0.0, min(100.0, p))

    def enable_rf(self):  # must never be called by the tuner
        self.rf_enabled_calls += 1

    def reverse_fraction(self):
        return reflected_fraction(self.tune, self.load, self.t_opt, self.l_opt)


def _telemetry(fake, *, rf_on=True, manual=True):
    return {"rf_on": rf_on, "manual_mode": manual, "reverse_fraction": fake.reverse_fraction()}


def test_converges_to_the_well_minimum_in_auto():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto"))
    mt.start()
    mt.arm()
    for _ in range(400):
        mt.tick(0.5, _telemetry(fake))
    assert fake.reverse_fraction() < FLOOR + 0.03  # reached near the floor


def test_advisory_mode_never_moves_caps():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="advisory"))
    mt.start()
    mt.arm()
    for _ in range(50):
        mt.tick(0.5, _telemetry(fake))
    assert (fake.tune, fake.load) == (50.0, 50.0)
    assert mt.snapshot()["recommended"] is not None


def test_never_enables_rf():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto"))
    mt.start()
    mt.arm()
    for _ in range(100):
        mt.tick(0.5, _telemetry(fake))
    assert fake.rf_enabled_calls == 0


def test_holds_when_rf_off_or_not_armed():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto"))
    mt.start()  # not armed
    for _ in range(20):
        mt.tick(0.5, _telemetry(fake))
    assert (fake.tune, fake.load) == (50.0, 50.0)
    mt.arm()
    for _ in range(20):
        mt.tick(0.5, _telemetry(fake, rf_on=False))  # RF off -> no drive + auto-disarm
    assert (fake.tune, fake.load) == (50.0, 50.0)
    assert mt.snapshot()["armed"] is False


def test_caps_stay_in_bounds():
    fake = FakeController(t_opt=95.0, l_opt=95.0)  # optimum outside [0,100] pull
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto", min_cap=0.0, max_cap=100.0))
    mt.start()
    mt.arm()
    for _ in range(300):
        mt.tick(0.5, _telemetry(fake))
    assert 0.0 <= fake.tune <= 100.0 and 0.0 <= fake.load <= 100.0
```

- [ ] **Step 2 — Run it, watch it fail** (no `MatchTuner`/`MatchTunerPlan`).

- [ ] **Step 3 — GREEN:** add to `control/match_tuner.py` (below `observe`):

```python
from dataclasses import dataclass
from typing import Any, Literal

MATCH_TUNER_BOUNDS: dict[str, tuple[float, float]] = {
    "tune_step": (0.1, 5.0),
    "load_step": (0.1, 5.0),
    "guard": (0.05, 1.0),
}


@dataclass
class MatchTunerPlan:
    mode: Literal["advisory", "auto"] = "advisory"
    tune_step: float = 1.0   # coarse (tune is hyper-sensitive -> larger capture step)
    load_step: float = 0.3   # fine (load is broad -> small trim step)
    min_cap: float = 0.0
    max_cap: float = 100.0
    eps: float = 0.003       # min reverse-fraction improvement that counts
    guard: float = 0.6       # reverse fraction above which we undo + hold
    settle_hold: int = 6     # ticks with no improvement before holding
    resume_delta: float = 0.03  # reverse rise above best that resumes searching


class MatchTuner:
    """Interleaved coordinate descent on reverse power; tune-coarse, load-fine."""

    def __init__(self, controller: Any, *, plan: MatchTunerPlan) -> None:
        self.controller = controller
        self.plan = plan
        self.running = False
        self.armed = False
        self.phase: Literal["idle", "searching", "holding"] = "idle"
        self._axis: Literal["tune", "load"] = "tune"
        self._tune_turn = 0  # weights tune 2:1 over load
        self._dir = {"tune": 1, "load": 1}
        self._prev_rev: float | None = None
        self._best: float | None = None
        self._no_improve = 0
        self._last_move: dict[str, Any] | None = None
        self._recommended: dict[str, float] | None = None

    # --- lifecycle ---
    def start(self) -> None:
        self.running = True
        self.phase = "searching"
        self._prev_rev = None
        self._best = None
        self._no_improve = 0

    def stop(self) -> None:
        self.running = False
        self.armed = False
        self.phase = "idle"

    def arm(self) -> None:
        self.armed = True

    def disarm(self) -> None:
        self.armed = False

    # --- helpers ---
    def _clamp(self, v: float) -> float:
        return max(self.plan.min_cap, min(self.plan.max_cap, round(v, 1)))

    def _next_axis(self) -> Literal["tune", "load"]:
        # tune, tune, load, repeat  (tune weighted 2:1)
        self._tune_turn = (self._tune_turn + 1) % 3
        return "load" if self._tune_turn == 0 else "tune"

    def _read(self, telemetry: dict[str, Any]) -> tuple[float, float, float, bool, bool]:
        tune = float(telemetry.get("tune_cap_percent", getattr(self.controller, "tune", 0.0)))
        load = float(telemetry.get("load_cap_percent", getattr(self.controller, "load", 0.0)))
        rev = float(telemetry["reverse_fraction"])
        return tune, load, rev, bool(telemetry.get("rf_on")), bool(telemetry.get("manual_mode", True))

    # --- the loop ---
    def tick(self, _dt: float, telemetry: dict[str, Any]) -> None:
        if not self.running:
            return
        tune, load, rev, rf_on, manual = self._read(telemetry)
        # Safety gate: only drive while armed + RF on + manual. RF-off auto-disarms.
        if not rf_on:
            self.armed = False
        can_drive = self.armed and rf_on and manual and self.plan.mode == "auto"

        # Update the direction of the axis we moved last tick, from the reverse-power change.
        if self._prev_rev is not None and self._last_move is not None:
            ax = self._last_move["axis"]
            new_dir, improved = observe(
                prev=self._prev_rev, curr=rev, direction=self._dir[ax], eps=self.plan.eps
            )
            self._dir[ax] = new_dir
            self._no_improve = 0 if improved else self._no_improve + 1

        self._best = rev if self._best is None else min(self._best, rev)

        # Guard: reverse too high -> undo the last move and hold a beat.
        if rev >= self.plan.guard and self._last_move is not None and can_drive:
            self._apply(self._last_move["axis"], -self._last_move["delta"], tune, load)
            self.phase = "holding"
            self._prev_rev = rev
            self._last_move = None
            return

        # Holding: monitor; resume searching if reverse creeps back up (drift).
        if self.phase == "holding":
            if self._best is not None and rev > self._best + self.plan.resume_delta:
                self.phase = "searching"
                self._no_improve = 0
            else:
                self._prev_rev = rev
                self._recommended = {"tune": tune, "load": load}
                return

        if self._no_improve >= self.plan.settle_hold:
            self.phase = "holding"
            self._prev_rev = rev
            return

        # Searching: pick the next axis and step it.
        ax = self._next_axis()
        step = self.plan.tune_step if ax == "tune" else self.plan.load_step
        delta = self._dir[ax] * step
        if ax == "tune":
            self._recommended = {"tune": self._clamp(tune + delta), "load": load}
        else:
            self._recommended = {"tune": tune, "load": self._clamp(load + delta)}
        if can_drive:
            self._apply(ax, delta, tune, load)
        self._last_move = {"axis": ax, "delta": delta}
        self._prev_rev = rev

    def _apply(self, axis: str, delta: float, tune: float, load: float) -> None:
        if axis == "tune":
            self.controller.set_tune_capacity(self._clamp(tune + delta))
        else:
            self.controller.set_load_capacity(self._clamp(load + delta))

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "armed": self.armed,
            "phase": self.phase,
            "mode": self.plan.mode,
            "reverse_fraction": self._prev_rev,
            "best": self._best,
            "last_move": self._last_move,
            "recommended": self._recommended,
        }
```

- [ ] **Step 4 — Run it, watch it pass** (all of `test_match_tuner.py`). If convergence is flaky,
tune `tune_step`/`load_step`/`settle_hold` in the plan defaults (not the test) until it settles near
the floor within 400 ticks. Then `ruff` + `mypy`.
- [ ] **Step 5 — Commit:** `feat(tuner): MatchTuner coordinate-descent loop with safety gates`.

---

## Task 4 (S4c): API wiring

**Files:** Modify `api/app.py`; create `backend/tests/test_api_match_tuner.py`.

- [ ] **Step 1 — RED:** `backend/tests/test_api_match_tuner.py` (mirror `test_api_ramp.py`):

```python
from fastapi.testclient import TestClient
from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path))


def test_config_exposes_bounds_and_defaults(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/match-tuner").json()
        assert b["mode"] == "advisory"
        assert "tune_step" in b["bounds"]


def test_status_has_match_tuner_block(tmp_path):
    with _client(tmp_path) as c:
        s = c.get("/api/status").json()["match_tuner"]
        assert s["running"] is False and s["armed"] is False


def test_start_arm_stop(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/match-tuner/start").json()["running"] is True
        assert c.post("/api/match-tuner/arm").json()["armed"] is True
        assert c.post("/api/match-tuner/stop").json()["running"] is False
```

- [ ] **Step 2 — Run it, watch it fail** (routes missing).
- [ ] **Step 3 — GREEN:** wire it exactly like ramp/timer:
  - import `MATCH_TUNER_BOUNDS, MatchTuner, MatchTunerPlan`.
  - lifespan: `mt = MatchTuner(controller, plan=MatchTunerPlan())`; the listener must pass telemetry —
    `controller.add_listener(lambda snap: mt.tick(poll_interval_s, _mt_telemetry(snap)))` where
    `_mt_telemetry` pulls `rf_on`, `manual_mode`, `tune_cap_percent`, `load_cap_percent`, and
    `reverse_fraction = reflected_fraction_from_snapshot` (use `telemetry.reflected_fraction`).
    NOTE: telemetry already carries `reflected_fraction` (= rev/fwd) — pass it as `reverse_fraction`.
  - `app.state.match_tuner = mt`; `_match_tuner()` accessor.
  - `MatchTunerBody` (mode, tune_step, load_step, guard). The PUT route builds a new `MatchTunerPlan`
    with `mode` validated to `{"advisory","auto"}` and each numeric field clamped into
    `MATCH_TUNER_BOUNDS` (add a `MatchTunerPlan.bounded(...)` classmethod mirroring `RampPlan.bounded`,
    TDD'd with a "clamps out-of-range steps" test).
  - routes `GET/PUT /api/match-tuner`, `POST /api/match-tuner/start|stop|arm|disarm`; add
    `"match_tuner": _match_tuner().snapshot()` to `_status_payload`.
  - The E-STOP endpoint (`/api/estop`) must also `_match_tuner().stop()` — add that line.
- [ ] **Step 4 — Run it, watch it pass;** full backend `pytest` + `ruff` + `mypy` green.
- [ ] **Step 5 — Commit:** `feat(api): match-tuner config/start/stop/arm + status; estop stops it too`.

---

## Task 5 (S4d): Match-tuner UI panel

**Files:** Modify `frontend/src/lib/telemetry.ts`, `frontend/src/lib/api.ts`, `frontend/src/App.tsx`,
`frontend/src/styles.css`.

- [ ] `telemetry.ts`: `MatchTunerStatus` (running, armed, phase, mode, reverse_fraction, best,
  recommended, last_move) + `MatchTunerConfig`; add `match_tuner` to `Status`.
- [ ] `api.ts`: `matchTuner()`, `saveMatchTuner(cfg)`, `matchTunerStart/Stop/Arm/Disarm`.
- [ ] `App.tsx`: a **Match tuner** panel in the matching-network column (under Presets). Controls:
  advisory/auto select, Start/Stop, **Arm** (enabled only while `rf_on` and connected; disabled with a
  hint otherwise), live readout — phase (searching/holding), current reverse %, best %, last move
  (e.g. "tune +1.0%"), and the recommended (tune,load) in advisory mode. An **Experimental — untested
  on hardware** banner (it drives caps). Reuse `.ramp-actions` styling.
- [ ] Browser-verify on :8010: enable RF (sim), set auto, Start + Arm, watch reverse % fall as the
  caps move; flip to advisory and confirm caps stop moving but a recommendation still updates.
- [ ] Frontend `node --test` for the new client methods; `npm run build` clean.
- [ ] Commit: `feat(ui): match-tuner panel (advisory/auto, arm-gated, live reverse trend)`.

---

## Task 6 (S2 leftover, optional): show the physical 0–5 cap value

**Files:** `frontend/src/lib/instrument.ts` (+ test), `frontend/src/App.tsx`.

- [ ] TDD a pure `capVolts(percent)` mapping % → the ~0–5 control value (approx linear:
  `0.12 + percent/100 * (4.92 - 0.12)` for tune; note load's ~0.11–4.93 is nearly the same). Flag in a
  comment that the mapping is **approximate / unverified** against the unit.
- [ ] Show it next to the `act …%` readback (e.g. `act 42.0% · ~2.13`). Browser-verify.

---

## Task 7: One end-to-end sim demonstration (verification gate, not shipped code)

- [ ] Drive the running sim on :8010: enable RF, `PUT /api/match-tuner {mode:"auto", ...}`, start + arm,
  and poll `/api/status` — assert `match_tuner.reverse_fraction` falls from a detuned start toward the
  floor, then (as the sim optimum drifts) rises and re-converges. Then trip protection (raise reverse
  past the limit) and confirm the tuner **disarms** and RF goes off. Capture the reverse-power trace and
  send it to Matt. This is the "watch it actually work against real-shaped data" gate from the spec.

## Self-review checklist
- [ ] Every backend unit watched RED→GREEN; `ruff` + `mypy` + `pytest` green; frontend build + tests green.
- [ ] The tuner **never** calls `enable_rf`; drives only while `armed && rf_on && manual`; caps clamped;
  holds/backs off on guard/no-improve; disarms on RF-off/fault; E-STOP stops it.
- [ ] Sim well shape matches the bench (sharp tune / broad load); optimum drifts; it's labeled a
  demonstration model calibrated in shape, not absolute position.
- [ ] UI panel is arm-gated and clearly marked experimental/untested-on-hardware.
