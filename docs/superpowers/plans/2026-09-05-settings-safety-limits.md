# Settings & Configurable Safety Limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the protection limits operator-adjustable within hard bounds and persisted, on a dedicated Settings page (which also absorbs the FLIR-link + operator-base controls), and move the T&C default port off 8000.

**Architecture:** `SafetyLimits` gains hard-bounded editable fields (`max_forward_w`, `max_reflected_w`, `temperature_c_trip`), persisted to a `.safety_limits.json` sidecar and swapped live into the `Controller` via `GET/PUT /api/safety-limits`. The reflected-power trip becomes absolute Watts. Frontend adds a Dashboard|Settings view switch.

**Tech Stack:** Python (FastAPI, pytest) backend; React/TS (`node --test`) frontend. Repo: `tc-power-interface`, branch `feat/settings`. Spec: `docs/superpowers/specs/2026-09-05-settings-safety-limits-design.md`.

---

## File Structure
- Modify `backend/tc_power_interface/control/safety.py` — field rename, `max_reflected_w` trip, hard bounds + `bounded()`.
- Create `backend/tc_power_interface/control/safety_store.py` — `.safety_limits.json` load/save.
- Modify `backend/tc_power_interface/control/controller.py` — `set_limits()`, snapshot `limits` block.
- Modify `backend/tc_power_interface/api/app.py` — load limits at startup, `GET/PUT /api/safety-limits`.
- Modify `backend/tc_power_interface/api/server.py` — default `--port 8010`.
- Modify `backend/tests/test_safety.py`, `test_controller.py`, `test_api.py`; create `test_safety_store.py`, `test_api_safety_limits.py`.
- Frontend: `src/lib/telemetry.ts` (Limits type), `src/lib/api.ts` (+safety-limits methods), `src/App.tsx` (view switch, move panels, Watts gauge, `max_forward_w`), plus `src/README`/docs port note.

---

## Task 1: `SafetyLimits` — rename, Watts trip, hard bounds

**Files:** Modify `backend/tc_power_interface/control/safety.py`; Test `backend/tests/test_safety.py`.

- [ ] **Step 1: Rewrite the safety tests** (replace `tests/test_safety.py` fully)

```python
"""Tests for the pure safety/protection evaluator (Watts-based reflected trip, hard-bounded)."""

from tc_power_interface.control.safety import (
    HARD_BOUNDS,
    SafetyLimits,
    evaluate,
)
from tc_power_interface.device.base import Telemetry
from tc_power_interface.protocol.codec import Status


def mk(**kw) -> Telemetry:
    base = dict(host_timestamp_ns=1, forward_w=0.0, reverse_w=0.0, load_w=0.0,
               reflected_fraction=0.0, status=Status(0), rf_on=False, temperature_c=30.0,
               operation_mode="normal", tuner="analog tuner")
    base.update(kw)
    return Telemetry(**base)


LIMITS = SafetyLimits()


class TestDefaults:
    def test_defaults(self):
        assert LIMITS.max_forward_w == 350
        assert LIMITS.max_reflected_w == 25.0
        assert LIMITS.temperature_c_trip == 70.0


class TestBounded:
    def test_clamps_each_field_into_hard_range(self):
        s = SafetyLimits.bounded(max_forward_w=9999, max_reflected_w=9999, temperature_c_trip=999)
        assert s.max_forward_w == HARD_BOUNDS["max_forward_w"][1]  # 400
        assert s.max_reflected_w == HARD_BOUNDS["max_reflected_w"][1]  # 200
        assert s.temperature_c_trip == HARD_BOUNDS["temperature_c_trip"][1]  # 90

    def test_clamps_up_to_minimums(self):
        s = SafetyLimits.bounded(max_forward_w=-5, max_reflected_w=0, temperature_c_trip=0)
        assert s.max_forward_w == 0
        assert s.max_reflected_w == HARD_BOUNDS["max_reflected_w"][0]  # 1
        assert s.temperature_c_trip == HARD_BOUNDS["temperature_c_trip"][0]  # 30

    def test_in_range_values_preserved(self):
        s = SafetyLimits.bounded(max_forward_w=300, max_reflected_w=40, temperature_c_trip=65)
        assert (s.max_forward_w, s.max_reflected_w, s.temperature_c_trip) == (300, 40.0, 65.0)


class TestClampSetpoint:
    def test_clamps_to_max_forward_w(self):
        assert SafetyLimits(max_forward_w=350).clamp_setpoint(1000) == 350
        assert SafetyLimits(max_forward_w=350).clamp_setpoint(100) == 100
        assert SafetyLimits(max_forward_w=350).clamp_setpoint(-5) == 0


class TestReflectedTrip:
    def test_trips_when_reverse_watts_exceed_limit(self):
        d = evaluate(mk(rf_on=True, forward_w=300, reverse_w=30.0),
                     SafetyLimits(max_reflected_w=25.0), telemetry_age_s=0.1)
        assert d.trip is True
        assert any("reflect" in r.lower() for r in d.reasons)

    def test_no_trip_below_limit_even_at_high_fraction(self):
        # 4 W reflected of 5 W forward = 80% fraction but only 4 W -> below a 25 W limit -> no trip
        d = evaluate(mk(rf_on=True, forward_w=5, reverse_w=4.0, reflected_fraction=0.8),
                     SafetyLimits(max_reflected_w=25.0), telemetry_age_s=0.1)
        assert d.trip is False

    def test_no_reflected_trip_when_rf_off(self):
        d = evaluate(mk(rf_on=False, reverse_w=999), LIMITS, telemetry_age_s=0.1)
        assert d.trip is False

    def test_fraction_warn_is_advisory_not_a_trip(self):
        d = evaluate(mk(rf_on=True, forward_w=300, reverse_w=10.0, reflected_fraction=0.05),
                     SafetyLimits(max_reflected_w=25.0, reflected_fraction_warn=0.02),
                     telemetry_age_s=0.1)
        assert d.trip is False
        assert d.warnings != ()


class TestHardwareFaults:
    def test_over_temperature_status_trips(self):
        assert evaluate(mk(status=Status.OVER_TEMPERATURE), LIMITS, 0.1).trip is True

    def test_interlock_open_trips(self):
        assert evaluate(mk(status=Status.INTERLOCK_OPEN), LIMITS, 0.1).trip is True

    def test_heatsink_over_limit_trips(self):
        assert evaluate(mk(temperature_c=95.0), LIMITS, 0.1).trip is True


class TestCommsTimeout:
    def test_stale_telemetry_trips(self):
        d = evaluate(mk(), LIMITS, telemetry_age_s=5.0)
        assert d.trip is True
```

- [ ] **Step 2: Run — verify RED**

Run: `cd backend && uv run pytest tests/test_safety.py -q`
Expected: FAIL (`ImportError: HARD_BOUNDS`, `SafetyLimits.bounded` missing, `max_forward_w` missing).

- [ ] **Step 3: Rewrite `SafetyLimits` + `evaluate`** in `control/safety.py`

Replace the `SafetyLimits` class and the reflected block of `evaluate` with:

```python
#: Hard outer bounds for the operator-editable limits: (min, max). Tighten-only — the operator
#: can never set a value outside these, so protection cannot be disabled or hardware over-driven.
HARD_BOUNDS: dict[str, tuple[float, float]] = {
    "max_forward_w": (0, 400),        # HT50 bank brief-test ceiling
    "max_reflected_w": (1.0, 200.0),
    "temperature_c_trip": (30.0, 90.0),
}


@dataclass(frozen=True)
class SafetyLimits:
    """Protection thresholds and command-side policy guards (editable ones are hard-bounded)."""

    #: Command-side ceiling on the forward-power setpoint (watts).
    max_forward_w: int = 350
    #: RF-off trip on absolute reflected power (watts) while RF is on.
    max_reflected_w: float = 25.0
    #: Heat-sink temperature trip (deg C).
    temperature_c_trip: float = 70.0
    #: Advisory-only reflected-fraction warn (drives the warnings banner, never trips).
    reflected_fraction_warn: float = 0.02
    #: Trip if the newest telemetry sample is older than this (must stay < 2 s control lease).
    telemetry_timeout_s: float = 1.5

    @classmethod
    def bounded(cls, *, max_forward_w: float, max_reflected_w: float,
                temperature_c_trip: float, reflected_fraction_warn: float = 0.02,
                telemetry_timeout_s: float = 1.5) -> "SafetyLimits":
        """Build limits with each editable field clamped into its hard range."""
        def clamp(name: str, value: float) -> float:
            lo, hi = HARD_BOUNDS[name]
            return max(lo, min(value, hi))
        return cls(
            max_forward_w=int(clamp("max_forward_w", max_forward_w)),
            max_reflected_w=float(clamp("max_reflected_w", max_reflected_w)),
            temperature_c_trip=float(clamp("temperature_c_trip", temperature_c_trip)),
            reflected_fraction_warn=reflected_fraction_warn,
            telemetry_timeout_s=telemetry_timeout_s,
        )

    def clamp_setpoint(self, watts: int) -> int:
        """Clamp a requested setpoint into ``[0, max_forward_w]``."""
        return max(0, min(int(watts), self.max_forward_w))
```

In `evaluate`, replace the whole `if telemetry.rf_on:` reflected block with:

```python
    if telemetry.rf_on:
        if telemetry.reverse_w > limits.max_reflected_w:
            reasons.append(
                f"reflected power {telemetry.reverse_w:.1f}W > {limits.max_reflected_w:.1f}W"
            )
        elif telemetry.reflected_fraction > limits.reflected_fraction_warn:
            warnings.append(
                f"reflected fraction {telemetry.reflected_fraction:.3f} above warn "
                f"{limits.reflected_fraction_warn:.3f}"
            )
```

- [ ] **Step 4: Run — verify GREEN**

Run: `cd backend && uv run pytest tests/test_safety.py -q` → PASS. (Other suites will break on the rename — fixed in Tasks 3/4.)

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/safety.py backend/tests/test_safety.py
git commit -m "feat(safety): Watts-based reflected trip + hard-bounded editable limits"
```

## Task 2: Persistence (`safety_store.py`)

**Files:** Create `backend/tc_power_interface/control/safety_store.py`; Test `backend/tests/test_safety_store.py`.

- [ ] **Step 1: Failing test**

```python
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.control.safety_store import load_limits, save_limits


def test_load_missing_returns_defaults(tmp_path):
    assert load_limits(tmp_path) == SafetyLimits()


def test_roundtrip_clamped(tmp_path):
    save_limits(tmp_path, SafetyLimits(max_forward_w=300, max_reflected_w=40, temperature_c_trip=65))
    loaded = load_limits(tmp_path)
    assert (loaded.max_forward_w, loaded.max_reflected_w, loaded.temperature_c_trip) == (300, 40.0, 65.0)


def test_load_clamps_out_of_range_file(tmp_path):
    (tmp_path / ".safety_limits.json").write_text(
        '{"max_forward_w": 9999, "max_reflected_w": 9999, "temperature_c_trip": 999}')
    loaded = load_limits(tmp_path)
    assert loaded.max_forward_w == 400 and loaded.max_reflected_w == 200.0 and loaded.temperature_c_trip == 90.0
```

- [ ] **Step 2: Run — RED** (`cd backend && uv run pytest tests/test_safety_store.py -q`) → module missing.

- [ ] **Step 3: Implement**

```python
# backend/tc_power_interface/control/safety_store.py
"""Persist the editable safety limits to a git-ignored .safety_limits.json sidecar."""
from __future__ import annotations

import json
from pathlib import Path

from tc_power_interface.control.safety import SafetyLimits

CONFIG_NAME = ".safety_limits.json"


def load_limits(root: Path) -> SafetyLimits:
    path = Path(root) / CONFIG_NAME
    try:
        d = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return SafetyLimits()
    return SafetyLimits.bounded(
        max_forward_w=d.get("max_forward_w", 350),
        max_reflected_w=d.get("max_reflected_w", 25.0),
        temperature_c_trip=d.get("temperature_c_trip", 70.0),
    )


def save_limits(root: Path, limits: SafetyLimits) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / CONFIG_NAME).write_text(json.dumps({
        "max_forward_w": limits.max_forward_w,
        "max_reflected_w": limits.max_reflected_w,
        "temperature_c_trip": limits.temperature_c_trip,
    }, indent=2))
```

- [ ] **Step 4: Run — GREEN.** **Step 5: Commit** (`feat(safety): persist editable limits to .safety_limits.json`).

## Task 3: `Controller.set_limits` + snapshot block

**Files:** Modify `backend/tc_power_interface/control/controller.py`; Test `backend/tests/test_controller.py`.

- [ ] **Step 1: Add failing tests** (append to `tests/test_controller.py`)

```python
class TestLimitsUpdate:
    def test_set_limits_swaps_live(self):
        from tc_power_interface.control.safety import SafetyLimits
        c = make_controller()
        c.set_limits(SafetyLimits(max_forward_w=100))
        assert c.limits.max_forward_w == 100
        # clamp uses the new limit immediately
        c.connect()
        assert c.set_setpoint(400) == 100

    def test_snapshot_limits_uses_new_field_names(self):
        c = make_controller()
        lim = c.snapshot()["limits"]
        assert set(lim) >= {"max_forward_w", "max_reflected_w", "temperature_c_trip",
                            "reflected_fraction_warn"}
```

Also fix the existing `TestSetpointGuard` in this file: it constructs `make_controller(max_setpoint_w=350)` — change that kwarg to `max_forward_w=350` (see `make_controller` helper, which forwards `**limit_kw` to `SafetyLimits(**limit_kw)`).

- [ ] **Step 2: Run — RED** (`set_limits` missing; snapshot has old keys).

- [ ] **Step 3: Implement** in `controller.py`:

Add method (near `set_setpoint`):
```python
    def set_limits(self, limits: SafetyLimits) -> None:
        with self._lock:
            self.limits = limits
```
Replace the snapshot `"limits"` block (currently lines ~206-211) with:
```python
            "limits": {
                "max_forward_w": self.limits.max_forward_w,
                "max_reflected_w": self.limits.max_reflected_w,
                "temperature_c_trip": self.limits.temperature_c_trip,
                "reflected_fraction_warn": self.limits.reflected_fraction_warn,
            },
```

- [ ] **Step 4: Run — GREEN** (`uv run pytest tests/test_controller.py -q`). **Step 5: Commit** (`feat(control): live set_limits + updated snapshot limits block`).

## Task 4: API — load at startup + `GET/PUT /api/safety-limits` + port

**Files:** Modify `backend/tc_power_interface/api/app.py`, `api/server.py`; Test `backend/tests/test_api_safety_limits.py`; fix `tests/test_api.py`.

- [ ] **Step 1: Failing test** (`tests/test_api_safety_limits.py`)

```python
from fastapi.testclient import TestClient
from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path))


def test_get_safety_limits_includes_values_and_bounds(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/safety-limits").json()
        assert b["max_forward_w"] == 350
        assert b["max_reflected_w"] == 25.0
        assert b["bounds"]["max_forward_w"] == [0, 400]


def test_put_clamps_persists_and_swaps_live(tmp_path):
    with _client(tmp_path) as c:
        r = c.put("/api/safety-limits", json={"max_forward_w": 9999, "max_reflected_w": 2,
                                              "temperature_c_trip": 65})
        assert r.status_code == 200
        assert r.json()["max_forward_w"] == 400  # clamped
        # persisted + live: setpoint now clamps to 400, and status reflects it
        assert c.get("/api/status").json()["controller"]["limits"]["max_forward_w"] == 400
```

Also update `tests/test_api.py`: the status-limits assertions that reference `max_setpoint_w`/`reflected_fraction_trip` must use `max_forward_w`/`max_reflected_w`.

- [ ] **Step 2: Run — RED** (404 on `/api/safety-limits`).

- [ ] **Step 3: Implement**

In `app.py`: at the top of the `lifespan`, load persisted limits and pass to the controller:
```python
from tc_power_interface.control.safety_store import load_limits, save_limits
# ...in lifespan, before building Controller:
        active_limits = load_limits(experiments_root)
        controller = Controller(CxnDevice(transport), limits=active_limits, poll_interval_s=poll_interval_s)
```
Add a Pydantic body + routes (near the other `/api/...` routes):
```python
from tc_power_interface.control.safety import HARD_BOUNDS, SafetyLimits

class SafetyLimitsBody(BaseModel):
    max_forward_w: float
    max_reflected_w: float
    temperature_c_trip: float

def _limits_payload() -> dict[str, Any]:
    lim = _controller().limits
    return {
        "max_forward_w": lim.max_forward_w,
        "max_reflected_w": lim.max_reflected_w,
        "temperature_c_trip": lim.temperature_c_trip,
        "bounds": {k: [v[0], v[1]] for k, v in HARD_BOUNDS.items()},
    }

@app.get("/api/safety-limits")
def get_safety_limits() -> dict[str, Any]:
    return _limits_payload()

@app.put("/api/safety-limits")
def put_safety_limits(body: SafetyLimitsBody) -> dict[str, Any]:
    new = SafetyLimits.bounded(max_forward_w=body.max_forward_w,
                               max_reflected_w=body.max_reflected_w,
                               temperature_c_trip=body.temperature_c_trip)
    _controller().set_limits(new)
    save_limits(experiments_root, new)
    return _limits_payload()
```

In `server.py`: change `parser.add_argument("--port", type=int, default=8000)` → `default=8010`.

- [ ] **Step 4: Run — GREEN** (`uv run pytest tests/test_api_safety_limits.py tests/test_api.py -q`), then full gate: `uv run pytest -q && uv run ruff check . && uv run mypy tc_power_interface`. **Step 5: Commit** (`feat(api): GET/PUT /api/safety-limits + load at startup + default port 8010`).

## Task 5: Frontend types + api client

**Files:** Modify `frontend/src/lib/telemetry.ts`, `frontend/src/lib/api.ts`.

- [ ] **Step 1:** In `telemetry.ts`, change the `Limits` interface to:
```typescript
export interface Limits {
  max_forward_w: number;
  max_reflected_w: number;
  temperature_c_trip: number;
  reflected_fraction_warn: number;
}
export interface SafetyLimitsForm { max_forward_w: number; max_reflected_w: number; temperature_c_trip: number; }
export interface SafetyLimitsStatus extends SafetyLimitsForm { bounds: Record<string, [number, number]>; }
```
- [ ] **Step 2:** In `api.ts`, add to the `api` object:
```typescript
  safetyLimits: async (): Promise<import("./telemetry.ts").SafetyLimitsStatus> =>
    (await fetch(apiUrl(BASE, "/api/safety-limits"))).json(),
  saveSafetyLimits: (v: import("./telemetry.ts").SafetyLimitsForm) => post("/api/safety-limits", v),
```
- [ ] **Step 3:** `cd frontend && npm test && npm run build` — Expected: green (no behavior change yet; App.tsx still compiles — it currently reads `limits.max_setpoint_w`, updated in Task 6). If the build fails on the removed `max_setpoint_w`, that is fixed in Task 6; you may do Steps of Task 6 in the same red-green if TS forces it.
- [ ] **Step 4: Commit** (`feat(ui): safety-limits API types + client`).

## Task 6: Settings view + move panels + Watts gauge (browser-verified)

**Files:** Modify `frontend/src/App.tsx` (+ `styles.css` if needed).

This is DOM/visual — verification gate is `tsc`/`build` clean + the Task 7 browser run.

- [ ] **Step 1:** Add a `view` state (`"dashboard" | "settings"`) and a top-bar toggle (`Dashboard | Settings`) rendered next to the pill.
- [ ] **Step 2:** Build a **Settings** section (shown when `view==="settings"`) containing:
  - a **Safety limits** form: number inputs for max forward W, max reflected W, over-temp °C, each showing its `bounds` range as a hint; a **Save** button calling `api.saveSafetyLimits(...)`; load current values via `api.safetyLimits()` on mount; show the clamped values returned by the PUT (so an out-of-range entry visibly snaps to the cap).
  - the **FLIR link** controls (URL + enable + status) — moved out of the dashboard Instruments panel.
  - the **operator base** field (currently in the top bar under `SITE_MODE`) — moved here.
- [ ] **Step 3:** Dashboard (`view==="dashboard"`): remove the Instruments panel; update the **setpoint hint** to read `limits.max_forward_w`; update the **reflected gauge** to read against `max_reflected_w` — show reflected in **Watts** (`t.reverse_w` of `max_reflected_w`) with the trip at full-scale and a warn zone at ≥50% of the limit. Keep the fault/warn banner (driven by `controller.warnings`/`fault_reasons`) as-is.
- [ ] **Step 4:** `cd frontend && npm run build` (tsc strict clean) and `npm test` still green.
- [ ] **Step 5: Commit** (`feat(ui): Settings page (limits + FLIR link + operator), Watts reflected gauge`).

## Task 7: End-to-end — edited limit trips live

- [ ] **Step 1:** `cd frontend && npm run build`; `cd ../backend && uv run tcp-serve --port 8010` (simulator).
- [ ] **Step 2:** `curl -X PUT localhost:8010/api/safety-limits -H 'content-type: application/json' -d '{"max_forward_w":350,"max_reflected_w":2,"temperature_c_trip":70}'` (tight 2 W reflected trip).
- [ ] **Step 3:** Set setpoint 300 + RF on (`curl -X POST localhost:8010/api/setpoint -d '{"watts":300}' -H 'content-type: application/json'; curl -X POST localhost:8010/api/rf/enable`).
- [ ] **Step 4:** Poll `curl localhost:8010/api/status` — the simulator's reflected is ~3 W (1% of 300) which exceeds the 2 W limit, so the controller must enter **fault** with a "reflected power … > 2.0W" reason and RF off. Confirm. Record the outcome in `plan/notes.md`.
- [ ] **Step 5:** Open the UI, switch to **Settings**, confirm the limits form + moved FLIR-link/operator controls render and round-trip (edit → save → reload). Screenshot.

---

## Self-review
- **Spec coverage:** editable+persisted limits (T1/T2/T4), Watts trip (T1), hard bounds tighten-only (T1/T4), live swap (T3/T4), Settings page + moved panels (T6), port 8010 (T4), e2e live-trip (T7). ✅
- **Rename ripples covered:** `max_setpoint_w`→`max_forward_w` updated in safety.py, controller snapshot, `make_controller`/`TestSetpointGuard` (T3), test_api.py (T4), telemetry.ts + App.tsx (T5/T6). Reflected fraction trip → `max_reflected_w` in safety.py + tests (T1).
- **Type consistency:** `SafetyLimits.bounded(max_forward_w, max_reflected_w, temperature_c_trip)`, `HARD_BOUNDS`, `Controller.set_limits`, `/api/safety-limits` payload with `bounds`, and the TS `Limits`/`SafetyLimitsForm`/`SafetyLimitsStatus` match across tasks.
