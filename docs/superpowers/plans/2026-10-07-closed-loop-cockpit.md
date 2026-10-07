# Closed-Loop Cockpit + Shadow Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Closed-loop tab with the v4 cockpit: analog power dials, setpoint, large Tune/Load, a run timeline, a live plant estimate, a shadow loop that never acts, watched core ROIs, run modes, and an in-app replay. Release as v0.17.0.

**Architecture:** The backend does the work: a pure `PlantEstimator` (RLS on a 5 s grid), a pure `ShadowLoop` (SIMC PI from the estimate), a pure `CoreWatch`, and a `CockpitObserver` that holds **no controller reference**, so it cannot actuate. One controller listener feeds it. Its outputs go into `/api/status`, `telemetry.csv` (appended columns) and a long-format `roi_temps.csv` sidecar. Replay re-runs the same Python modules over a recording. The frontend adds pure `lib/cockpit/*` logic (TDD) and a new `CockpitPage` that reuses `Gauge` and the Dashboard setpoint handlers.

**Tech Stack:** Python 3.13 + FastAPI + pytest (`uv run python -m pytest`), React 18 + TypeScript + Vite, tests via `node --experimental-strip-types --test`.

**Spec:** `docs/superpowers/specs/2026-10-06-closed-loop-cockpit-design.md` (decisions D1–D12). **Mockup v4:** https://claude.ai/artifact/NpXFcTejYFQ2ZNk3i92gkw

---

## Ground rules (read before every task)

- **Red-green TDD.** Write the test, run it, see it fail *for the stated reason*, implement, run it, see it pass, commit. UI-only steps name a concrete verification gate instead.
- **Never actuate.** Nothing new may call `set_setpoint`, `enable_rf`, `set_tune`/`set_load` or any cap command. Engage is locked (HTTP 409).
- **Unknown is None/blank, never 0** (data-contract rule 5).
- **No run-specific numbers baked into defaults** (Matt: the network is still changing between runs). The ladder default is an empty list.
- **No layout shift.** A change in data never moves the page. Mode and view switches keep the strip height fixed.
- Backend tests: `cd backend && uv run python -m pytest tests/<file> -v`. Full suite: `cd backend && uv run python -m pytest -q`.
- Frontend tests: `cd frontend && node --experimental-strip-types --test src/lib/cockpit/<file>.test.ts`. Full suite: `cd frontend && npm test`. Type check + build: `cd frontend && npm run build`.
- Commit messages: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/closed-loop-cockpit`. **Do not push, merge, restart the operator or deploy**; those need Matt's OK.

## Evidence this plan builds on (verified 2026-10-07)

| Fact | Evidence |
|---|---|
| Real run for the fixtures | FLIR `20261002_125228_Run`, cached at `tools/flir/.cache/20261002_125228_Run.{control,series,detail}.json` (git-ignored), loader `tools/flir/runview.py:load` |
| Estimator on that run (Python port of the mockup) | end: K = 0.526 °C/W, τ = 208 s, confidence 0.76, 157 updates; shadow suggestion 61.3 W toward 55 °C; T_amb 23.79 °C |
| At grid index 100 (8.3 min) the estimate is not yet usable | mockup JS on the same data: confidence 0.00 |
| Synthetic first-order plant with power steps | K within 2 %, τ within 9 % (K 0.5/τ 150 → 0.505/163; K 0.15/τ 200 → 0.152/213) |
| Steady power **is** identifiable on a clean synthetic plant after ~240 s (conf 0.74) | so the spec's "constant power keeps confidence < 0.3" is replaced by: confidence 0 for the first 120 s, and < 0.3 at 8.3 min on the real run |
| Recorder columns fixed at run start | `backend/tc_power_interface/recording/recorder.py:29-57`, header written at `:122` |
| Setpoint is not recorded or remembered | `Controller.set_setpoint` (`control/controller.py:411-416`) does not store it; `snapshot()` (`:501-545`) has no setpoint |
| Thermal listener runs before auto-log and recorder | `api/app.py:284-328` |
| Link-drop cleanup does not stop an auto recording | `api/app.py:490-498` (`_on_link_dropped`) |
| Live limits | `max_forward_w 400, max_reflected_w 15, forward_caution_w 400, forward_danger_w 500` (`GET /api/status` → `controller.limits`, 2026-10-07); gauge scale `device.power_limit_w ?? 600` (`frontend/src/hooks/useOperator.ts:470`) |

---

## File map

**Backend (create)**
- `backend/tc_power_interface/control/plant_estimator.py`: live first-order estimate (pure).
- `backend/tc_power_interface/control/shadow_loop.py`: SIMC PI suggestion, plateau, time to target, settle time (pure).
- `backend/tc_power_interface/control/core_watch.py`: watched-ROI temperatures and 60 s rates (pure).
- `backend/tc_power_interface/control/run_mode.py`: run-mode value object, parsing and persistence.
- `backend/tc_power_interface/control/cockpit.py`: `CockpitObserver` composing the three, per-run reset, snapshot and record fields. No controller reference.
- `backend/tc_power_interface/recording/replay_shadow.py`: loads a run's power + ROI series and re-runs the estimator and shadow loop.
- `backend/tests/fixtures/flir_20261002_125228_estimator.json`: real-data fixture (captured, not invented).
- Tests: `test_plant_estimator.py`, `test_shadow_loop.py`, `test_core_watch.py`, `test_run_mode.py`, `test_cockpit_observer.py`, `test_replay_shadow.py`, `test_api_cockpit.py`.

**Backend (modify)**
- `control/thermal_store.py`: `watch` list in `.thermal_source.json`.
- `control/controller.py`: remember `commanded_setpoint_w`.
- `recording/recorder.py`: appended columns and the `roi_temps.csv` sidecar.
- `api/app.py`: wiring, endpoints, the engage 409, replay endpoints, and the auto-recording stop on link drop.
- `tests/test_thermal_temperature_path.py`: the `load_source` contract now includes `watch`.

**Tools**
- `tools/flir/build_estimator_fixture.py`: builds the fixture from the cache.
- `tools/flir/dead_time.py`: measures θ (power step → part response) on real runs.

**Frontend (create)**
- `frontend/src/lib/cockpit/{format,shadowText,gates,timeline,ladder,history,replay}.ts` + `.test.ts` each.
- `frontend/src/components/cockpit/{SetpointEntry,PowerDials,CockpitStrip,CockpitTimeline,ThermalColumn,RunModeColumn,WatchColumn,RunsView}.tsx`
- `frontend/src/pages/CockpitPage.tsx`, `frontend/src/hooks/useCockpitHistory.ts`, `frontend/src/cockpit.css`

**Frontend (modify)**
- `lib/telemetry.ts` (types), `lib/api.ts` (calls), `components/RfPowerPanel.tsx` (uses `SetpointEntry`), `App.tsx` (Closed loop → `CockpitPage`), `pages/SettingsPage.tsx` (core warn thresholds), `lib/settings_store.ts` (key), `package.json` (0.17.0).

---

## Phase A: Backend

### Task 1: Real-data fixture for the estimator

Data capture, not logic, so no red-green. Gate: the builder's printed summary must match the evidence table.

**Files:**
- Create: `tools/flir/build_estimator_fixture.py`
- Create: `backend/tests/fixtures/flir_20261002_125228_estimator.json`

- [ ] **Step 1: Write the builder**

```python
"""Build the estimator test fixture from the cached REAL FLIR run 20261002_125228 (data-contract rule 3:
fixtures are captured, never invented). Resamples TC-POWER forward power and every FLIR ROI mean onto a
5 s grid (np.interp), the same grid the estimator uses. Usage (repo root):
    python3 tools/flir/build_estimator_fixture.py
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from runview import load  # noqa: E402

RUN = "20261002_125228_Run"
OUT = Path("backend/tests/fixtures/flir_20261002_125228_estimator.json")


def main() -> None:
    ts, ser, C = load(f"tools/flir/.cache/{RUN}")
    t = np.arange(0, C["t_s"][-1] + 1e-9, 5.0)
    fwd = np.interp(t, C["t_s"], np.nan_to_num(C["forward_w"]))
    rois = {name: [round(float(v), 3) for v in np.interp(t, ts, s)] for name, s in ser.items()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": f"FLIR {RUN} + TC-POWER control stream, resampled to 5 s (tools/flir/build_estimator_fixture.py)",
        "t_s": [float(x) for x in t],
        "forward_w": [round(float(x), 2) for x in fwd],
        "rois": rois,
    }))
    print(f"{len(t)} samples, {len(rois)} ROIs, part freehand_sample {rois['freehand_sample'][0]} -> {rois['freehand_sample'][-1]} C")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

Run: `python3 tools/flir/build_estimator_fixture.py`
Expected: `162 samples, 11 ROIs, part freehand_sample 23.79 -> 52.6x C` (within 0.01 of the mockup data). If the cache is missing, run `tools/flir/fetch_runs.py` first (it needs the FLIR tool on :8000 and the SSD mounted).

- [ ] **Step 3: Commit**

```bash
git add tools/flir/build_estimator_fixture.py backend/tests/fixtures/flir_20261002_125228_estimator.json
git commit -m "test(fixtures): real 10-02 FLIR run resampled to 5 s for the plant estimator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `PlantEstimator`

**Files:**
- Create: `backend/tc_power_interface/control/plant_estimator.py`
- Test: `backend/tests/test_plant_estimator.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Live first-order plant estimate (spec §3.2). Real-data expectations come from the captured 10-02 run."""
import json
from pathlib import Path

import numpy as np

from tc_power_interface.control.plant_estimator import PlantEstimator

FIX = json.loads((Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text())


def _simulate(k, tau, profile, noise, dt=0.5, t0=24.0, seed=0):
    """First-order plant dT/dt = (K/tau)P - (T-T0)/tau, sampled every dt with seeded noise."""
    rng = np.random.default_rng(seed)
    est, temp, out = PlantEstimator(), t0, None
    for n in range(int(profile[-1][0] / dt)):
        t = n * dt
        p = next(w for t_end, w in profile if t < t_end)
        temp += (k / tau * p - (temp - t0) / tau) * dt
        out = est.add(t, p, temp + rng.normal(0, noise), rf_on=True)
    return out


def test_power_steps_recover_gain_and_time_constant_within_10_percent():
    steps = [(180, 20), (360, 40), (540, 60), (720, 40)]
    for k, tau in [(0.5, 150), (0.15, 200)]:
        e = _simulate(k, tau, steps, noise=0.05)
        assert e.valid
        assert abs(e.k_c_per_w - k) / k < 0.10
        assert abs(e.tau_s - tau) / tau < 0.10
        assert e.confidence > 0.8


def test_no_estimate_in_the_first_two_minutes_of_steady_power():
    e = _simulate(0.5, 150, [(120, 40)], noise=0.1)
    assert not e.valid and e.confidence == 0.0 and e.k_c_per_w is None


def test_unknown_temperature_is_skipped_never_treated_as_zero():
    est = PlantEstimator()
    for n in range(200):
        t = n * 5.0
        temp = None if n % 10 == 0 else 24 + 0.05 * n
        e = est.add(t, 40.0, temp, rf_on=True)
    assert e.t_amb_c is not None and e.t_amb_c > 20  # never 0 from a missing reading


def test_rf_off_samples_do_not_update():
    est = PlantEstimator()
    for n in range(100):
        e = est.add(n * 5.0, 40.0, 24.0 + n * 0.1, rf_on=False)
    assert e.updates == 0 and not e.valid


def test_real_run_converges_and_is_unsure_early():
    est = PlantEstimator()
    mid = None
    for i, (t, p, temp) in enumerate(zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"])):
        e = est.add(t, p, temp, rf_on=p >= 1)
        if i == 100:
            mid = e
    assert mid is not None and mid.confidence < 0.3  # 8.3 min: steady power, not yet separable
    assert 0.35 <= e.k_c_per_w <= 0.65  # measured 0.526
    assert 100 <= e.tau_s <= 250  # measured 208 s
    assert e.confidence >= 0.5  # measured 0.76
    assert abs(e.t_amb_c - 23.79) < 0.01


def test_reset_starts_a_new_run():
    est = PlantEstimator()
    for t, p, temp in zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"]):
        est.add(t, p, temp, rf_on=p >= 1)
    est.reset()
    assert est.estimate().updates == 0 and est.estimate().t_amb_c is None
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && uv run python -m pytest tests/test_plant_estimator.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tc_power_interface.control.plant_estimator'`.

- [ ] **Step 3: Implement**

```python
"""Live estimate of the part's first-order heating response: dT/dt = a·P − b·(T − T_amb).

K = a/b (°C per W) and τ = 1/b (s), by recursive least squares on a fixed 5 s grid (the first tick at
or after each grid time is taken). Derivative = central difference of a centred 30 s moving average,
so each update lags the newest sample by 20 s. T_amb = the temperature at the first RF-on grid
sample. Pure: no I/O and no actuators. Spec §3.2 of the cockpit design.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

GRID_S = 5.0
HALF_WINDOW = 3  # 7 grid points = a 30 s centred moving average
LAG = 4  # smoothing (3) + central difference (1)
FORGET = 0.995
RESID_ALPHA = 0.05
MIN_UPDATES = 6
COV_INIT = 100.0
MIN_POWER_W = 1.0


@dataclass(frozen=True)
class PlantEstimate:
    k_c_per_w: float | None
    tau_s: float | None
    confidence: float
    t_amb_c: float | None
    updates: int

    @property
    def valid(self) -> bool:
        return self.k_c_per_w is not None


class PlantEstimator:
    """Feed every telemetry tick to :meth:`add`; it keeps one sample per 5 s grid step."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._t_next: float | None = None
        self._p: list[float] = []
        self._t: list[float | None] = []
        self._theta = [0.0, 0.0]
        self._cov = [[COV_INIT, 0.0], [0.0, COV_INIT]]
        self._r2 = 0.0
        self._n = 0
        self._t_amb: float | None = None
        self.grid_samples = 0

    def add(self, t_s: float, power_w: float, temp_c: float | None, *, rf_on: bool) -> PlantEstimate:
        if self._t_next is not None and t_s < self._t_next:
            return self.estimate()
        self._t_next = t_s + GRID_S if self._t_next is None else self._t_next + GRID_S
        while self._t_next <= t_s:
            self._t_next += GRID_S
        p = float(power_w) if rf_on else 0.0
        self._p.append(p)
        self._t.append(temp_c)
        self.grid_samples += 1
        if self._t_amb is None and p >= MIN_POWER_W and temp_c is not None:
            self._t_amb = float(temp_c)
        self._update(len(self._t) - 1)
        return self.estimate()

    def _smoothed(self, k: int) -> float | None:
        window = self._t[max(0, k - HALF_WINDOW): k + HALF_WINDOW + 1]
        vals = [v for v in window if v is not None]
        return sum(vals) / len(vals) if len(vals) == len(window) else None

    def _update(self, i: int) -> None:
        j = i - LAG
        if self._t_amb is None or j < 1 or self._p[j] < MIN_POWER_W:
            return
        lo, mid, hi = self._smoothed(j - 1), self._smoothed(j), self._smoothed(j + 1)
        if lo is None or mid is None or hi is None:
            return
        y = (hi - lo) / (2 * GRID_S)
        phi = (self._p[j], -(mid - self._t_amb))
        c = self._cov
        pp = (c[0][0] * phi[0] + c[0][1] * phi[1], c[1][0] * phi[0] + c[1][1] * phi[1])
        den = FORGET + phi[0] * pp[0] + phi[1] * pp[1]
        gain = (pp[0] / den, pp[1] / den)
        err = y - (phi[0] * self._theta[0] + phi[1] * self._theta[1])
        self._theta = [self._theta[0] + gain[0] * err, self._theta[1] + gain[1] * err]
        self._cov = [
            [(c[0][0] - gain[0] * pp[0]) / FORGET, (c[0][1] - gain[0] * pp[1]) / FORGET],
            [(c[1][0] - gain[1] * pp[0]) / FORGET, (c[1][1] - gain[1] * pp[1]) / FORGET],
        ]
        self._r2 = err * err if self._n == 0 else (1 - RESID_ALPHA) * self._r2 + RESID_ALPHA * err * err
        self._n += 1

    def estimate(self) -> PlantEstimate:
        a, b = self._theta
        if self._n < MIN_UPDATES or a <= 0 or b <= 0:
            return PlantEstimate(None, None, 0.0, self._t_amb, self._n)
        se_a = math.sqrt(max(self._cov[0][0], 0.0) * self._r2)
        se_b = math.sqrt(max(self._cov[1][1], 0.0) * self._r2)
        conf = min(1.0, max(0.0, 1.0 - (se_a / a + se_b / b)))
        return PlantEstimate(a / b, 1.0 / b, conf, self._t_amb, self._n)
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && uv run python -m pytest tests/test_plant_estimator.py -v`
Expected: 6 passed. If `test_real_run_converges_and_is_unsure_early` misses, compare against the evidence values (0.526 / 208 s / 0.76) before touching thresholds. A mismatch is an implementation bug, not a tolerance problem.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/plant_estimator.py backend/tests/test_plant_estimator.py
git commit -m "feat(control): live first-order plant estimator (RLS on a 5 s grid)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `ShadowLoop` and the plateau/time maths

**Files:**
- Create: `backend/tc_power_interface/control/shadow_loop.py`
- Test: `backend/tests/test_shadow_loop.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Shadow PI (spec §3.3): bounded, rate-limited, bumpless, and pure (it has nothing to actuate)."""
import inspect
import json
import math
from pathlib import Path

import pytest

from tc_power_interface.control import shadow_loop
from tc_power_interface.control.plant_estimator import PlantEstimate, PlantEstimator
from tc_power_interface.control.shadow_loop import (
    ShadowLoop, pi_gains, plateau_c, settle_time_s, time_to_target_s,
)

FIX = json.loads((Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text())
GOOD = PlantEstimate(k_c_per_w=0.5, tau_s=150.0, confidence=0.8, t_amb_c=24.0, updates=50)


def test_simc_gains():
    kc, ti = pi_gains(0.5, 150.0)
    tc = max(150 / 2, 30)  # 75
    assert kc == pytest.approx(150 / (0.5 * (tc + shadow_loop.DEAD_TIME_S)))
    assert ti == pytest.approx(min(150, 4 * (tc + shadow_loop.DEAD_TIME_S)))


def test_plateau_time_to_target_and_settle():
    assert plateau_c(24.0, 0.5, 70.0) == pytest.approx(59.0)
    assert time_to_target_s(59.0, 55.0, 40.0, 150.0) == pytest.approx(-150 * math.log(4 / 19))
    assert time_to_target_s(50.0, 55.0, 40.0, 150.0) is None  # levels off below the target
    assert time_to_target_s(59.0, 55.0, 56.0, 150.0) is None  # already above it
    assert settle_time_s(59.0, 40.0, 150.0) == pytest.approx(150 * math.log(19))
    assert settle_time_s(59.0, 58.5, 150.0) == 0.0  # within 1 °C already


def test_no_suggestion_without_a_valid_estimate_or_temperature():
    sl = ShadowLoop()
    none_est = PlantEstimate(None, None, 0.0, 24.0, 2)
    assert sl.step(none_est, temp_c=30.0, power_w=40.0, target_c=55.0, ceiling_w=200).suggest_w is None
    assert sl.step(GOOD, temp_c=None, power_w=40.0, target_c=55.0, ceiling_w=200).suggest_w is None


def test_bumpless_start_rate_limit_and_ceiling():
    sl = ShadowLoop()
    first = sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120).suggest_w
    assert first == pytest.approx(50.0)  # starts from YOUR 40 W, moves at most 10 W
    outs = [sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120).suggest_w for _ in range(30)]
    assert all(b - a <= 10.0 + 1e-9 for a, b in zip([first, *outs], outs))
    assert max(outs) == pytest.approx(120.0)  # clamped to the ceiling


def test_reset_forgets_the_integral():
    sl = ShadowLoop()
    for _ in range(20):
        sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120)
    sl.reset()
    assert sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120).suggest_w == pytest.approx(50.0)


def test_real_run_suggests_a_physical_hold_power():
    est, sl, out = PlantEstimator(), ShadowLoop(), None
    for t, p, temp in zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"]):
        e = est.add(t, p, temp, rf_on=p >= 1)
        out = sl.step(e, temp_c=temp, power_w=p, target_c=55.0, ceiling_w=200)
    # Steady-state hold for 55 °C from T_amb 23.8 at K 0.526 is ~59 W; measured suggestion 61.3 W.
    assert 50.0 <= out.suggest_w <= 75.0


def test_module_has_no_actuator_access():
    src = inspect.getsource(shadow_loop)
    for forbidden in ("set_setpoint", "enable_rf", "set_tune", "set_load", "controller"):
        assert forbidden not in src
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && uv run python -m pytest tests/test_shadow_loop.py -v`
Expected: FAIL with `ImportError: cannot import name 'ShadowLoop'` (module missing).

- [ ] **Step 3: Implement**

```python
"""Shadow loop: the power a PI loop WOULD set to reach the target, from the live plant estimate.

SIMC tuning from (K, τ): τc = max(τ/2, 30 s), θ = DEAD_TIME_S, Kc = τ / (K(τc + θ)), Ti = min(τ, 4(τc + θ)).
The integral starts at the operator's current power (bumpless) and is clamped to [0, ceiling]; the
suggestion is clamped to [0, ceiling] and moves at most MAX_STEP_W per step, starting from your power
(checked 2026-10-07: the real-run end value stays 61.3 W). Call :meth:`step` once
per estimator grid sample (5 s). Pure: it is handed numbers and returns numbers. Spec §3.3.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from tc_power_interface.control.plant_estimator import GRID_S, PlantEstimate

DEAD_TIME_S = 10.0  # provisional; Task 4 measures it on real runs
MIN_TC_S = 30.0
MAX_STEP_W = 10.0
SETTLE_BAND_C = 1.0


def pi_gains(k: float, tau: float) -> tuple[float, float]:
    tc = max(tau / 2.0, MIN_TC_S)
    return tau / (k * (tc + DEAD_TIME_S)), min(tau, 4.0 * (tc + DEAD_TIME_S))


def plateau_c(t_amb: float, k: float, power_w: float) -> float:
    return t_amb + k * power_w


def time_to_target_s(plateau: float, target: float, temp: float, tau: float) -> float | None:
    if not (plateau > target > temp):
        return None
    return -tau * math.log((plateau - target) / (plateau - temp))


def settle_time_s(plateau: float, temp: float, tau: float) -> float:
    gap = abs(plateau - temp)
    return 0.0 if gap <= SETTLE_BAND_C else tau * math.log(gap / SETTLE_BAND_C)


@dataclass(frozen=True)
class ShadowOutput:
    suggest_w: float | None


class ShadowLoop:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._integral: float | None = None
        self._prev: float | None = None

    def step(self, est: PlantEstimate, *, temp_c: float | None, power_w: float, target_c: float,
             ceiling_w: float) -> ShadowOutput:
        if not est.valid or temp_c is None:
            return ShadowOutput(None)
        assert est.k_c_per_w is not None and est.tau_s is not None
        kc, ti = pi_gains(est.k_c_per_w, est.tau_s)
        err = target_c - temp_c
        if self._integral is None:  # bumpless: integral AND rate limiter start from the operator's power
            self._integral = float(power_w)
            self._prev = float(power_w)
        self._integral = min(ceiling_w, max(0.0, self._integral + kc * err * GRID_S / ti))
        u = min(ceiling_w, max(0.0, kc * err + self._integral))
        if self._prev is not None:
            u = min(self._prev + MAX_STEP_W, max(self._prev - MAX_STEP_W, u))
        self._prev = u
        return ShadowOutput(u)
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && uv run python -m pytest tests/test_shadow_loop.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/shadow_loop.py backend/tests/test_shadow_loop.py
git commit -m "feat(control): shadow PI loop (SIMC from the live estimate, bumpless, rate-limited)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Measure θ (dead time) on the real run

This is an analysis, not logic. Gate: the script's printed lag, recorded in the findings note.

**Files:**
- Create: `tools/flir/dead_time.py`
- Modify: `docs/superpowers/notes/2026-10-06-closed-loop-data-findings.md` (append a §θ line)
- Modify, only if the measurement says so: `backend/tc_power_interface/control/shadow_loop.py` (`DEAD_TIME_S`)

- [ ] **Step 1: Write the script**

```python
"""Dead time θ between a power step and the part's response, from the real 10-02 fixture.

Cross-correlates dP/dt with d²T/dt² (the response to a step starts as a change in heating rate) over lags
0–60 s on the 5 s grid. Usage (repo root): python3 tools/flir/dead_time.py [roi]
"""
import json
import sys

import numpy as np

fix = json.load(open("backend/tests/fixtures/flir_20261002_125228_estimator.json"))
roi = sys.argv[1] if len(sys.argv) > 1 else "freehand_sample"
p = np.array(fix["forward_w"])
t = np.convolve(np.array(fix["rois"][roi]), np.ones(3) / 3, mode="same")
dp, d2t = np.diff(p)[2:], np.diff(t, 2)[1:]
lags = range(0, 13)  # 0..60 s
score = [float(np.dot(dp[: len(dp) - k], d2t[k: len(dp)])) for k in lags]
best = int(np.argmax(score))
print(f"{roi}: theta ~ {best * 5} s (scores by lag {[round(s, 2) for s in score]})")
```

- [ ] **Step 2: Run it**

Run: `python3 tools/flir/dead_time.py && python3 tools/flir/dead_time.py SQ_SAMPLE`
Record both printed lags.

- [ ] **Step 3: Decide**
  - If both lags are within 5 s of 10 s, keep `DEAD_TIME_S = 10.0`. Change the comment to `# measured 2026-10-xx: <lags> on the 10-02 run (tools/flir/dead_time.py)`.
  - If they agree with each other but not with 10 s, set `DEAD_TIME_S` to their mean (rounded to 5 s). Re-run `uv run python -m pytest tests/test_shadow_loop.py -v`. `test_simc_gains` reads the constant, and `test_real_run_suggests_a_physical_hold_power` must still pass. If it fails, stop and report it; don't widen the bound.
  - If they disagree by more than 10 s, keep 10 s and write the disagreement in the note.

- [ ] **Step 4: Append to the findings note and commit**

Append to `docs/superpowers/notes/2026-10-06-closed-loop-data-findings.md`:
`- θ (dead time, power step → part response), 10-02 run via tools/flir/dead_time.py: freehand_sample <x> s, SQ_SAMPLE <y> s → DEAD_TIME_S = <value>.`
Fill `<x>`, `<y>` and `<value>` from Step 2's printed output.

```bash
git add tools/flir/dead_time.py docs/superpowers/notes/2026-10-06-closed-loop-data-findings.md backend/tc_power_interface/control/shadow_loop.py
git commit -m "chore(analysis): measure shadow-loop dead time on the 10-02 run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: `CoreWatch` and watched-ROI persistence

**Files:**
- Create: `backend/tc_power_interface/control/core_watch.py`
- Modify: `backend/tc_power_interface/control/thermal_store.py:52-71`
- Test: `backend/tests/test_core_watch.py`
- Modify: `backend/tests/test_thermal_temperature_path.py:106-109`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_core_watch.py`:

```python
"""Watched ROIs (cores): value or a reason, and a 60 s rate that stays None until it has 60 s of data."""
from tc_power_interface.control.core_watch import CoreWatch, MAX_WATCH
from tc_power_interface.control.thermal_store import load_source, save_source


def _feed(c):
    return [{"name": "toroid_C", "mean_c": c, "valid": True}, {"name": "toroid_D", "mean_c": None, "valid": False}]


def test_value_reason_and_rate():
    w = CoreWatch()
    out = []
    for n in range(0, 140):  # 0.5 s ticks, +0.05 °C per tick = 6 °C/min
        out = w.update(n * 0.5, _feed(30.0 + 0.05 * n), ["toroid_C", "toroid_D", "toroid_X"])
        if n * 0.5 < 59.9:
            assert out[0]["rate_c_per_min"] is None  # needs 60 s of valid samples
    c, d, x = out
    assert c["status"] == "ok" and abs(c["rate_c_per_min"] - 6.0) < 0.05
    assert d == {"name": "toroid_D", "temp_c": None, "rate_c_per_min": None, "status": "invalid"}
    assert x["status"] == "not_in_feed" and x["temp_c"] is None


def test_an_invalid_sample_restarts_the_rate_window():
    w = CoreWatch()
    for n in range(130):
        w.update(n * 0.5, _feed(30.0 + 0.05 * n), ["toroid_C"])
    w.update(65.5, [{"name": "toroid_C", "mean_c": None, "valid": False}], ["toroid_C"])
    assert w.update(66.0, _feed(40.0), ["toroid_C"])[0]["rate_c_per_min"] is None


def test_watch_list_persists_with_the_source_and_is_bounded(tmp_path):
    assert load_source(tmp_path, default_type="flir") == {"type": "flir", "roi": None, "watch": []}
    save_source(tmp_path, {"type": "flir", "roi": "freehand_sample", "watch": ["toroid_C", "toroid_D"]})
    assert load_source(tmp_path, default_type="simulated")["watch"] == ["toroid_C", "toroid_D"]
    save_source(tmp_path, {"type": "flir", "roi": None, "watch": ["a", "b", "c", "d", "e", 7]})
    assert load_source(tmp_path, default_type="flir")["watch"] == ["a", "b", "c", "d"][:MAX_WATCH]
```

In `backend/tests/test_thermal_temperature_path.py`, the contract now includes `watch`. Replace lines 107 and 109 with:

```python
    assert load_source(tmp_path, default_type="flir") == {"type": "flir", "roi": None, "watch": []}
    save_source(tmp_path, {"type": "flir", "roi": "freehand_sample"})
    assert load_source(tmp_path, default_type="simulated") == {"type": "flir", "roi": "freehand_sample", "watch": []}
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && uv run python -m pytest tests/test_core_watch.py tests/test_thermal_temperature_path.py -v`
Expected: FAIL. `ModuleNotFoundError: ...core_watch`, and the two path tests fail with a missing `watch` key.

- [ ] **Step 3: Implement**

`backend/tc_power_interface/control/core_watch.py`:

```python
"""Watched ROIs (transformer cores first): each one's mean temperature or a reason, plus the rate of
rise over a trailing 60 s window of VALID samples (None until the window spans 60 s). Display and
warn only (D3); the RF-off interlock is a separate build (v0.18). Pure."""

from __future__ import annotations

from collections import deque
from typing import Any

WINDOW_S = 60.0
MAX_WATCH = 4


class CoreWatch:
    def __init__(self) -> None:
        self._hist: dict[str, deque[tuple[float, float]]] = {}

    def reset(self) -> None:
        self._hist.clear()

    def update(self, t_s: float, roi_temps: list[dict[str, Any]], names: list[str]) -> list[dict[str, Any]]:
        by_name = {r.get("name"): r for r in roi_temps}
        out: list[dict[str, Any]] = []
        for name in names[:MAX_WATCH]:
            r = by_name.get(name)
            hist = self._hist.setdefault(name, deque())
            if r is None or not r.get("valid") or r.get("mean_c") is None:
                hist.clear()  # the window must be continuous valid data
                out.append({"name": name, "temp_c": None, "rate_c_per_min": None,
                            "status": "not_in_feed" if r is None else "invalid"})
                continue
            c = float(r["mean_c"])
            hist.append((t_s, c))
            while len(hist) > 2 and hist[1][0] <= t_s - WINDOW_S:
                hist.popleft()
            t0, c0 = hist[0]
            rate = (c - c0) / (t_s - t0) * 60.0 if t_s - t0 >= WINDOW_S - 1e-9 else None
            out.append({"name": name, "temp_c": c, "rate_c_per_min": rate, "status": "ok"})
        for gone in set(self._hist) - set(names):
            del self._hist[gone]
        return out
```

In `backend/tc_power_interface/control/thermal_store.py`, replace `load_source` and `save_source` (lines 55-71):

```python
def _watch_list(raw: object) -> list[str]:
    from tc_power_interface.control.core_watch import MAX_WATCH

    names = [n for n in raw if isinstance(n, str) and n] if isinstance(raw, list) else []
    return list(dict.fromkeys(names))[:MAX_WATCH]


def load_source(root: Path, *, default_type: str) -> dict[str, Any]:
    """The operator's temperature-source choice: ``{"type": "flir"|"simulated", "roi": name|None,
    "watch": [names]}``.

    No ROI name is ever invented: FLIR ROIs are redrawn between prints (``circle_medium_small`` existed
    on 09-08 and not after), so until the operator picks one the ROI is None and the loop says so. The
    watched ROIs default to none, for the same reason.
    """
    try:
        d = json.loads((Path(root) / SOURCE_NAME).read_text())
    except (FileNotFoundError, ValueError):
        return {"type": default_type, "roi": None, "watch": []}
    kind = d.get("type") if d.get("type") in ("flir", "simulated") else default_type
    roi = d.get("roi")
    return {"type": kind, "roi": roi if isinstance(roi, str) and roi else None, "watch": _watch_list(d.get("watch"))}


def save_source(root: Path, source: dict[str, Any]) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / SOURCE_NAME).write_text(json.dumps(
        {"type": source.get("type"), "roi": source.get("roi"), "watch": _watch_list(source.get("watch", []))}
    ))
```

Add `from typing import Any` to the file's imports.

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && uv run python -m pytest tests/test_core_watch.py tests/test_thermal_temperature_path.py tests/test_thermal_store.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/core_watch.py backend/tc_power_interface/control/thermal_store.py backend/tests/test_core_watch.py backend/tests/test_thermal_temperature_path.py
git commit -m "feat(control): watched ROIs with 60 s rate of rise; watch list persists with the source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Remember the commanded setpoint

**Files:**
- Modify: `backend/tc_power_interface/control/controller.py` (`__init__`, `estop` at :220-236, `set_setpoint` at :411-416, `snapshot` at :508)
- Test: `backend/tests/test_controller.py` (append)

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_controller.py`)

```python
def test_snapshot_reports_the_last_commanded_setpoint(tmp_path):
    """The recorder needs the requested power (spec §3.4); front-panel changes are not seen, so the
    name says what it is: the last setpoint TC-POWER commanded."""
    from fastapi.testclient import TestClient

    from tc_power_interface.api.app import create_app

    with TestClient(create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)) as c:
        ctrl = c.app.state.controller
        assert ctrl.snapshot()["commanded_setpoint_w"] is None  # nothing commanded yet: unknown, not 0
        c.post("/api/arm")
        c.post("/api/setpoint", json={"watts": 42})
        assert ctrl.snapshot()["commanded_setpoint_w"] == 42
        c.post("/api/estop")
        assert ctrl.snapshot()["commanded_setpoint_w"] == 0
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && uv run python -m pytest tests/test_controller.py::test_snapshot_reports_the_last_commanded_setpoint -v`
Expected: FAIL with `KeyError: 'commanded_setpoint_w'`.

- [ ] **Step 3: Implement**
  - In `Controller.__init__` (after `self.limits = ...`): `self.commanded_setpoint_w: int | None = None  # last setpoint TC-POWER sent (front-panel changes are not seen)`
  - In `set_setpoint`, after `self.device.set_setpoint(clamped)` (inside the lock): `self.commanded_setpoint_w = clamped`
  - In `estop`, after the `dev.set_setpoint(0)` try-block succeeds: `self.commanded_setpoint_w = 0`. Put it inside the `try` after the call, so a failed write doesn't claim 0.
  - In `snapshot()`, add `"commanded_setpoint_w": self.commanded_setpoint_w,` next to `"armed"`.

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && uv run python -m pytest tests/test_controller.py tests/test_api_estop.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/controller.py backend/tests/test_controller.py
git commit -m "feat(controller): expose the last commanded setpoint (unknown until one is sent)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Recorder: appended columns and the `roi_temps.csv` sidecar

**Files:**
- Modify: `backend/tc_power_interface/recording/recorder.py:29-57` (fields), `record()`, `_writer_loop()`, `start()`, `stop()`
- Test: `backend/tests/test_recording.py` (append)

- [ ] **Step 1: Write the failing tests** (append)

```python
def test_cockpit_columns_are_appended_and_unknown_is_blank(tmp_path):
    import csv

    from tc_power_interface.recording.recorder import TelemetryRecorder

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    tel = {"host_timestamp_ns": 1, "forward_w": 40.0, "reverse_w": 0.1, "load_w": 39.9, "reflected_fraction": 0.0025,
           "rf_on": True, "temperature_c": 30.0, "operation_mode": "m", "tuner": "t", "status": 0}
    rec.record({"telemetry": tel, "state": "connected", "commanded_setpoint_w": 40,
                "cockpit": {"part_roi": "freehand_sample", "part_temp_c": 41.2, "temp_status": "ok",
                            "shadow_k": None, "run_mode": "ladder", "target_c": 55.0}})
    rec.stop()
    header = (run / "telemetry.csv").read_text().splitlines()[0].split(",")
    assert header[-12:] == ["setpoint_w", "part_roi", "part_temp_c", "temp_status", "shadow_k", "shadow_tau_s",
                            "shadow_conf", "shadow_suggest_w", "shadow_plateau_c", "shadow_ttt_s", "run_mode", "target_c"]
    assert header[0] == "host_timestamp_ns"  # old layout first, unchanged
    row = next(csv.DictReader((run / "telemetry.csv").open()))
    assert row["setpoint_w"] == "40" and row["part_temp_c"] == "41.2" and row["shadow_k"] == ""


def test_every_roi_goes_to_a_long_format_sidecar(tmp_path):
    import csv
    import json

    from tc_power_interface.recording.recorder import TelemetryRecorder

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    tel = {"host_timestamp_ns": 5, "forward_w": 1.0, "reverse_w": 0.0, "load_w": 1.0, "reflected_fraction": 0.0,
           "rf_on": True, "temperature_c": 30.0, "operation_mode": "m", "tuner": "t", "status": 0}
    rec.record({"telemetry": tel, "state": "connected", "roi_temps": [
        {"name": "toroid_C", "mean_c": 31.5, "valid": True}, {"name": "SQ_SAMPLE", "mean_c": None, "valid": False}]})
    rec.stop()
    rows = list(csv.DictReader((run / "roi_temps.csv").open()))
    assert rows == [{"host_timestamp_ns": "5", "roi": "toroid_C", "mean_c": "31.5"},
                    {"host_timestamp_ns": "5", "roi": "SQ_SAMPLE", "mean_c": ""}]  # invalid = blank, never 0
    assert "roi_temps.csv" in json.loads((run / "manifest.json").read_text())["checksums"]
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && uv run python -m pytest tests/test_recording.py -v -k "cockpit or sidecar"`
Expected: FAIL. The header has no `setpoint_w`, and `roi_temps.csv` doesn't exist.

- [ ] **Step 3: Implement**
  - After `_MATCH_FIELDS` add:

    ```python
    #: Cockpit columns (2026-10-07, spec §3.4), APPENDED after all pre-existing columns. Unknown = blank.
    _COCKPIT_FIELDS = ["part_roi", "part_temp_c", "temp_status", "shadow_k", "shadow_tau_s", "shadow_conf",
                       "shadow_suggest_w", "shadow_plateau_c", "shadow_ttt_s", "run_mode", "target_c"]
    _CSV_FIELDS = [*_TELEMETRY_FIELDS, "controller_state", *_THERMAL_FIELDS, *_MATCH_FIELDS, "setpoint_w", *_COCKPIT_FIELDS]
    _ROI_FIELDS = ["host_timestamp_ns", "roi", "mean_c"]
    ```

    Remove the old `_CSV_FIELDS` line.
  - In `__init__`: `self._roi_file: TextIO | None = None` and `self._roi_writer: Any = None`. Change the queue type to `queue.Queue[tuple[str, Any]]`.
  - In `start()`, after the telemetry writer: open `run_dir / "roi_temps.csv"` the same way with `fieldnames=_ROI_FIELDS` and write its header.
  - In `record()`, before `self._queue.put(row)`:

    ```python
    row["setpoint_w"] = snapshot.get("commanded_setpoint_w")
    cockpit = snapshot.get("cockpit") or {}
    for key in _COCKPIT_FIELDS:
        row[key] = cockpit.get(key)
    ts = telemetry.get("host_timestamp_ns")
    roi_rows = [
        {"host_timestamp_ns": ts, "roi": r.get("name"), "mean_c": r.get("mean_c") if r.get("valid") else None}
        for r in (snapshot.get("roi_temps") or []) if r.get("name")
    ]
    ```

    Then enqueue `self._queue.put(("telemetry", row))`, and `if roi_rows: self._queue.put(("roi", roi_rows))`.
  - Add `_write_roi_rows(self, rows)`, which writes each row and flushes `self._roi_file`. In `_writer_loop`, unpack `kind, payload = self._queue.get(...)` and dispatch: `self._write_row(payload)` for `"telemetry"`, `self._write_roi_rows(payload)` for `"roi"`. Keep the `_write_row(row)` seam (`tests/test_recording.py:72` monkeypatches it).
  - In `stop()`: close `_roi_file` next to `_csv_file`, and add `"roi_temps.csv": _sha256(run_dir / "roi_temps.csv")` to the checksums.

- [ ] **Step 4: Run, expect PASS** (whole recorder + recordings API, to catch layout regressions)

Run: `cd backend && uv run python -m pytest tests/test_recording.py tests/test_api_recordings.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/recording/recorder.py backend/tests/test_recording.py
git commit -m "feat(recording): setpoint + cockpit columns appended; every ROI to a roi_temps.csv sidecar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Run mode

**Files:**
- Create: `backend/tc_power_interface/control/run_mode.py`
- Test: `backend/tests/test_run_mode.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Run mode = display and bookkeeping only (spec §3.5): it never changes power by itself."""
import pytest

from tc_power_interface.control.run_mode import RunMode, load_run_mode, parse_run_mode, save_run_mode


def test_defaults_bake_in_no_run_numbers():
    assert RunMode() == RunMode(mode="ladder", ladder_w=(), fixed_w=0, fixed_min=0.0)


def test_parse_clamps_sorts_and_rejects():
    m = parse_run_mode({"mode": "ladder", "ladder_w": [40, 5, 5, 999, -3, "x"]}, max_forward_w=400)
    assert m.ladder_w == (5, 40, 400)
    assert parse_run_mode({"mode": "fixed", "fixed_w": 900, "fixed_min": 10}, max_forward_w=400).fixed_w == 400
    with pytest.raises(ValueError, match="not available"):
        parse_run_mode({"mode": "angle"}, max_forward_w=400)
    with pytest.raises(ValueError, match="unknown"):
        parse_run_mode({"mode": "warp"}, max_forward_w=400)


def test_persists(tmp_path):
    assert load_run_mode(tmp_path) == RunMode()
    save_run_mode(tmp_path, RunMode(mode="target"))
    assert load_run_mode(tmp_path).mode == "target"
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && uv run python -m pytest tests/test_run_mode.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
"""Run mode for the cockpit: what the operator is doing (ladder / fixed / to-temperature). Display and
bookkeeping ONLY. It never sets power (D1). The to-temperature target lives in the thermal plan
(`PUT /api/thermal/plan`), not here, so there is one source of truth for the target."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

MODES = ("ladder", "fixed", "target")
FILE_NAME = ".run_mode.json"


@dataclass(frozen=True)
class RunMode:
    mode: str = "ladder"
    ladder_w: tuple[int, ...] = ()  # no default steps: the network still changes between runs
    fixed_w: int = 0
    fixed_min: float = 0.0


def parse_run_mode(body: dict[str, Any], *, max_forward_w: int) -> RunMode:
    mode = body.get("mode")
    if mode == "angle":
        raise ValueError("angle schedule is not available yet (turntable not built)")
    if mode not in MODES:
        raise ValueError(f"unknown run mode: {mode!r}")
    clamp = lambda w: int(max(0, min(int(w), max_forward_w)))  # noqa: E731
    steps = sorted({clamp(w) for w in body.get("ladder_w", []) if isinstance(w, (int, float)) and w > 0})
    return RunMode(mode=mode, ladder_w=tuple(steps),
                   fixed_w=clamp(body.get("fixed_w", 0) or 0),
                   fixed_min=max(0.0, float(body.get("fixed_min", 0) or 0)))


def load_run_mode(root: Path) -> RunMode:
    try:
        d = json.loads((Path(root) / FILE_NAME).read_text())
        return parse_run_mode(d, max_forward_w=10_000)
    except (FileNotFoundError, ValueError, TypeError):
        return RunMode()


def save_run_mode(root: Path, m: RunMode) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / FILE_NAME).write_text(json.dumps({**asdict(m), "ladder_w": list(m.ladder_w)}))
```

- [ ] **Step 4: Run, expect PASS** → `cd backend && uv run python -m pytest tests/test_run_mode.py -v`

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/run_mode.py backend/tests/test_run_mode.py
git commit -m "feat(control): run mode (ladder/fixed/target) as display-only bookkeeping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: `CockpitObserver`

**Files:**
- Create: `backend/tc_power_interface/control/cockpit.py`
- Test: `backend/tests/test_cockpit_observer.py`

- [ ] **Step 1: Write the failing tests**

```python
"""The observer composes estimator + shadow + core watch, resets per recording, and cannot actuate."""
import inspect
import json
from pathlib import Path

from tc_power_interface.control import cockpit
from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode

FIX = json.loads((Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text())


def _replay(obs, run_id="run1", mode="target"):
    for t, p in zip(FIX["t_s"], FIX["forward_w"]):
        rois = [{"name": n, "mean_c": FIX["rois"][n][FIX["t_s"].index(t)], "valid": True} for n in FIX["rois"]]
        part = FIX["rois"]["freehand_sample"][FIX["t_s"].index(t)]
        obs.observe(t_s=t, telemetry={"forward_w": p, "rf_on": p >= 1}, part_roi="freehand_sample",
                    part_temp_c=part, temp_status="ok", roi_temps=rois, watch=["toroid_C"], run_id=run_id,
                    run_mode=RunMode(mode=mode), target_c=55.0, ceiling_w=200.0)


def test_real_run_snapshot_and_record_fields():
    obs = CockpitObserver()
    _replay(obs)
    s = obs.snapshot()
    sh = s["shadow"]
    assert 0.35 <= sh["k_c_per_w"] <= 0.65 and sh["valid"] and sh["confidence"] >= 0.5
    assert 50 <= sh["suggest_w"] <= 75  # to-temperature mode shows a suggestion
    assert sh["plateau_c"] is not None and sh["settle_s"] is not None
    assert s["watch"][0]["name"] == "toroid_C" and s["watch"][0]["rate_c_per_min"] is not None
    r = obs.record_fields()
    assert r["part_roi"] == "freehand_sample" and r["run_mode"] == "target" and r["target_c"] == 55.0
    assert r["shadow_suggest_w"] == sh["suggest_w"]


def test_no_suggestion_outside_to_temperature_mode_but_plateau_still_shown():
    obs = CockpitObserver()
    _replay(obs, mode="ladder")
    sh = obs.snapshot()["shadow"]
    assert sh["suggest_w"] is None and sh["plateau_c"] is not None
    assert obs.record_fields()["target_c"] is None  # no target outside to-temperature mode


def test_a_new_recording_resets_the_estimate():
    obs = CockpitObserver()
    _replay(obs, run_id="run1")
    obs.observe(t_s=10_000.0, telemetry={"forward_w": 40.0, "rf_on": True}, part_roi="freehand_sample",
                part_temp_c=30.0, temp_status="ok", roi_temps=[], watch=[], run_id="run2",
                run_mode=RunMode(mode="target"), target_c=55.0, ceiling_w=200.0)
    sh = obs.snapshot()["shadow"]
    assert not sh["valid"] and sh["k_c_per_w"] is None and sh["why"] == "learning"


def test_cannot_actuate_by_construction():
    params = inspect.signature(CockpitObserver.__init__).parameters
    assert set(params) == {"self"}  # no controller is ever handed in
    src = inspect.getsource(cockpit)
    for forbidden in ("set_setpoint", "enable_rf", "set_tune", "set_load"):
        assert forbidden not in src
```

- [ ] **Step 2: Run, expect FAIL** → `cd backend && uv run python -m pytest tests/test_cockpit_observer.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
"""Cockpit observer: feeds every telemetry tick to the plant estimator, the shadow loop and the core
watch, and reports their state for /api/status and the recorder. It is handed NUMBERS, never the
controller, so it cannot command power, RF or caps (D1, spec §5). Resets when a new recording starts."""

from __future__ import annotations

from typing import Any

from tc_power_interface.control.core_watch import CoreWatch
from tc_power_interface.control.plant_estimator import PlantEstimate, PlantEstimator
from tc_power_interface.control.run_mode import RunMode
from tc_power_interface.control.shadow_loop import (
    ShadowLoop, plateau_c, settle_time_s, time_to_target_s,
)

SHOW_CONFIDENCE = 0.3


class CockpitObserver:
    def __init__(self) -> None:
        self._est = PlantEstimator()
        self._shadow = ShadowLoop()
        self._watch = CoreWatch()
        self._run_id: str | None = None
        self._last: dict[str, Any] = {}
        self._watch_out: list[dict[str, Any]] = []
        self._suggest: float | None = None
        self._estimate: PlantEstimate = self._est.estimate()

    def observe(self, *, t_s: float, telemetry: dict[str, Any], part_roi: str | None, part_temp_c: float | None,
                temp_status: str, roi_temps: list[dict[str, Any]], watch: list[str], run_id: str | None,
                run_mode: RunMode, target_c: float, ceiling_w: float) -> None:
        if run_id != self._run_id and run_id is not None:
            self._est.reset()
            self._shadow.reset()
            self._watch.reset()
            self._suggest = None
        self._run_id = run_id
        power = float(telemetry.get("forward_w") or 0.0)
        rf_on = bool(telemetry.get("rf_on"))
        before = self._est.grid_samples
        self._estimate = self._est.add(t_s, power, part_temp_c, rf_on=rf_on)
        if self._est.grid_samples != before:  # the shadow loop steps once per 5 s grid sample
            out = self._shadow.step(self._estimate, temp_c=part_temp_c, power_w=power,
                                    target_c=target_c, ceiling_w=ceiling_w)
            self._suggest = out.suggest_w if run_mode.mode == "target" else None
        self._watch_out = self._watch.update(t_s, roi_temps, watch)
        self._last = {"part_roi": part_roi, "part_temp_c": part_temp_c, "temp_status": temp_status,
                      "power_w": power, "run_mode": run_mode.mode, "target_c": target_c}

    def _shadow_block(self) -> dict[str, Any]:
        e, last = self._estimate, self._last
        temp, power = last.get("part_temp_c"), last.get("power_w", 0.0)
        plateau = settle = ttt = None
        if e.valid and e.t_amb_c is not None and temp is not None:
            assert e.k_c_per_w is not None and e.tau_s is not None
            plateau = plateau_c(e.t_amb_c, e.k_c_per_w, power)
            settle = settle_time_s(plateau, temp, e.tau_s)
            if last.get("run_mode") == "target":
                ttt = time_to_target_s(plateau, last["target_c"], temp, e.tau_s)
        why = None if e.valid else ("learning" if e.updates < 6 else "no consistent first-order fit yet")
        return {"valid": e.valid, "why": why, "k_c_per_w": e.k_c_per_w, "tau_s": e.tau_s,
                "confidence": e.confidence, "t_amb_c": e.t_amb_c, "updates": e.updates,
                "suggest_w": self._suggest, "plateau_c": plateau, "settle_s": settle, "ttt_s": ttt,
                "show": e.valid and e.confidence >= SHOW_CONFIDENCE}

    def snapshot(self) -> dict[str, Any]:
        return {"shadow": self._shadow_block(), "watch": list(self._watch_out)}

    def record_fields(self) -> dict[str, Any]:
        sh, last = self._shadow_block(), self._last
        return {"part_roi": last.get("part_roi"), "part_temp_c": last.get("part_temp_c"),
                "temp_status": last.get("temp_status"), "shadow_k": sh["k_c_per_w"], "shadow_tau_s": sh["tau_s"],
                "shadow_conf": sh["confidence"] if sh["valid"] else None, "shadow_suggest_w": sh["suggest_w"],
                "shadow_plateau_c": sh["plateau_c"], "shadow_ttt_s": sh["ttt_s"], "run_mode": last.get("run_mode"),
                "target_c": last.get("target_c") if last.get("run_mode") == "target" else None}
```

- [ ] **Step 4: Run, expect PASS** → `cd backend && uv run python -m pytest tests/test_cockpit_observer.py -v`

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/control/cockpit.py backend/tests/test_cockpit_observer.py
git commit -m "feat(control): cockpit observer (estimate + shadow + core watch), per-run reset, no actuator access

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Wire the cockpit into the API

**Files:**
- Modify: `backend/tc_power_interface/api/app.py`: lifespan (:264-328), `_status_payload` (:517-544), new endpoints after `/api/thermal/roi` (:726-735)
- Test: `backend/tests/test_api_cockpit.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Cockpit API: status blocks, watch + run-mode endpoints, engage locked, and nothing actuates."""
import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path))


def test_status_has_cockpit_blocks(tmp_path):
    with _client(tmp_path) as c:
        th = c.get("/api/status").json()["thermal"]
        assert th["watch"] == [] and th["run_mode"]["mode"] == "ladder"
        assert th["shadow"]["valid"] is False and th["shadow"]["why"] == "learning"
        assert th["engage"] == {"available": False, "reason": "core interlock not built yet (v0.18)"}


def test_watch_endpoint_validates_and_persists(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/thermal/watch", json={"names": ["toroid_C", "toroid_D"]}).status_code == 200
        assert c.post("/api/thermal/watch", json={"names": ["a", "b", "c", "d", "e"]}).status_code == 422
    with _client(tmp_path) as c:  # survives an operator restart
        assert [w["name"] for w in c.get("/api/status").json()["thermal"]["watch"]] == ["toroid_C", "toroid_D"]


def test_run_mode_endpoint(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/run-mode", json={"mode": "ladder", "ladder_w": [10, 5]})
        assert r.status_code == 200 and r.json()["ladder_w"] == [5, 10]
        assert c.post("/api/run-mode", json={"mode": "angle"}).status_code == 422


def test_engage_is_locked(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/thermal/engage")
        assert r.status_code == 409 and "interlock" in r.json()["detail"]


def test_cockpit_never_commands_power(tmp_path):
    with _client(tmp_path) as c:
        calls = []
        ctrl = c.app.state.controller
        real = ctrl.set_setpoint
        ctrl.set_setpoint = lambda w: calls.append(w) or real(w)
        c.post("/api/run-mode", json={"mode": "target"})
        c.post("/api/thermal/watch", json={"names": ["toroid_C"]})
        c.post("/api/rf/enable")
        time.sleep(0.8)  # ~16 ticks with RF on: the observer runs every tick
        c.post("/api/rf/disable")
        assert calls == []
```

- [ ] **Step 2: Run, expect FAIL** → `cd backend && uv run python -m pytest tests/test_api_cockpit.py -v` → `KeyError: 'watch'` / 404s.

- [ ] **Step 3: Implement** (in `app.py`)
  - Imports: `from tc_power_interface.control.cockpit import CockpitObserver`, `from tc_power_interface.control.core_watch import MAX_WATCH`, `from tc_power_interface.control.run_mode import load_run_mode, parse_run_mode, save_run_mode`, and `import time`.
  - Pydantic bodies, next to `ThermalRoiBody`:

    ```python
    class WatchBody(BaseModel):
        names: list[str] = Field(default_factory=list, max_length=4)


    class RunModeBody(BaseModel):
        mode: str
        ladder_w: list[float] = Field(default_factory=list)
        fixed_w: float = 0
        fixed_min: float = 0
    ```

    `Field` comes from `pydantic`. `max_length=4` gives the 422.
  - Lifespan, after `app.state.control_roi = src_cfg["roi"]`: `app.state.watch_rois = src_cfg["watch"]` and `app.state.run_mode = load_run_mode(experiments_root)`. After creating `thermal`: `cockpit = CockpitObserver()` and `app.state.cockpit = cockpit`.
  - Inside `_thermal_tick`, right after `thermal.tick(poll_interval_s)`:

    ```python
            src = thermal.source
            cockpit.observe(
                t_s=time.monotonic(), telemetry=snap.get("telemetry") or {}, part_roi=app.state.control_roi,
                part_temp_c=thermal.control_temp_c, temp_status=getattr(src, "status", "simulated"),
                roi_temps=thermal_extra(src)["roi_temps"], watch=app.state.watch_rois, run_id=app.state.current_run,
                run_mode=app.state.run_mode, target_c=thermal.plan.target_c,
                ceiling_w=float(min(thermal.plan.loop_ceiling_w, controller.limits.max_forward_w)),
            )
    ```

  - Replace the recorder listener lambda with:

    ```python
        controller.add_listener(lambda snap: recorder.record({
            **snap, "thermal": thermal.snapshot(), "cockpit": cockpit.record_fields(),
            "roi_temps": thermal_extra(thermal.source)["roi_temps"],
        }))
    ```

  - In `_status_payload()`'s `"thermal"` block, add:

    ```python
                **app.state.cockpit.snapshot(),  # "shadow" + "watch"
                "run_mode": {**asdict(app.state.run_mode), "ladder_w": list(app.state.run_mode.ladder_w)},
                "engage": {"available": False, "reason": "core interlock not built yet (v0.18)"},
    ```

    (`from dataclasses import asdict`.)
  - Each `save_source(...)` call in `thermal_source` and `thermal_roi` must now pass `"watch": app.state.watch_rois`.
  - New endpoints:

    ```python
    @app.post("/api/thermal/watch")
    def thermal_watch(body: WatchBody) -> dict[str, Any]:
        names = list(dict.fromkeys(n for n in body.names if n))[:MAX_WATCH]
        app.state.watch_rois = names
        save_source(experiments_root, {"type": app.state.thermal_source, "roi": app.state.control_roi, "watch": names})
        return {"watch": names}

    @app.get("/api/run-mode")
    def get_run_mode() -> dict[str, Any]:
        m = app.state.run_mode
        return {**asdict(m), "ladder_w": list(m.ladder_w)}

    @app.post("/api/run-mode")
    def set_run_mode(body: RunModeBody) -> dict[str, Any]:
        try:
            m = parse_run_mode(body.model_dump(), max_forward_w=_controller().limits.max_forward_w)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        app.state.run_mode = m
        save_run_mode(experiments_root, m)
        return {**asdict(m), "ladder_w": list(m.ladder_w)}

    @app.post("/api/thermal/engage")
    def thermal_engage() -> dict[str, Any]:
        # D12: the temperature loop may not drive power until the core interlock exists (v0.18).
        raise HTTPException(status_code=409, detail="locked: the core interlock is not built yet (v0.18)")
    ```

- [ ] **Step 4: Run, expect PASS** (plus the API suites that touch thermal and recording)

Run: `cd backend && uv run python -m pytest tests/test_api_cockpit.py tests/test_api_thermal.py tests/test_api_recordings.py tests/test_thermal_temperature_path.py tests/test_flir_thermal_wiring.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/api/app.py backend/tests/test_api_cockpit.py
git commit -m "feat(api): cockpit status (shadow, watch, run mode), watch/run-mode endpoints, engage locked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Replay: recordings with ROI data, ROI list, events, and shadow re-run

**Files:**
- Create: `backend/tc_power_interface/recording/replay_shadow.py`
- Modify: `backend/tc_power_interface/api/app.py` (`list_recordings` at :1040; new endpoints after `download_recording`)
- Test: `backend/tests/test_replay_shadow.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Replay re-runs the SAME estimator + shadow over a recording (one implementation, spec §3.5)."""
import csv
import json
from pathlib import Path

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app
from tc_power_interface.control.plant_estimator import PlantEstimator
from tc_power_interface.recording.replay_shadow import recorded_rois, replay_shadow

FIX = json.loads((Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text())
BASE_NS = 1_790_000_000 * 10**9


def _write_run(root: Path, name="20261002_125227_RF") -> Path:
    """A recording laid out exactly as the recorder writes it, filled from the REAL 10-02 data."""
    d = root / name
    d.mkdir(parents=True)
    with (d / "telemetry.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["host_timestamp_ns", "forward_w", "reverse_w", "rf_on"])
        w.writeheader()
        for t, p in zip(FIX["t_s"], FIX["forward_w"]):
            w.writerow({"host_timestamp_ns": BASE_NS + int(t * 1e9), "forward_w": p, "reverse_w": 0.0, "rf_on": p >= 1})
    with (d / "roi_temps.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["host_timestamp_ns", "roi", "mean_c"])
        w.writeheader()
        for i, t in enumerate(FIX["t_s"]):
            for name, series in FIX["rois"].items():
                w.writerow({"host_timestamp_ns": BASE_NS + int(t * 1e9), "roi": name, "mean_c": series[i]})
    (d / "events.json").write_text(json.dumps([{"host_timestamp_ns": BASE_NS, "label": "recording_started", "data": {}}]))
    return d


def test_replay_matches_the_live_estimator(tmp_path):
    run = _write_run(tmp_path)
    assert recorded_rois(run) == sorted(FIX["rois"])
    out = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)
    est = PlantEstimator()
    for t, p, temp in zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"]):
        e = est.add(t, p, temp, rf_on=p >= 1)
    last = out["points"][-1]
    assert abs(last["k_c_per_w"] - e.k_c_per_w) < 1e-6 and 50 <= last["suggest_w"] <= 75


def test_api_replay_endpoints(tmp_path):
    _write_run(tmp_path)
    with TestClient(create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)) as c:
        runs = c.get("/api/recordings").json()["runs"]
        assert runs[0]["has_roi_data"] is True
        assert "freehand_sample" in c.get("/api/recordings/20261002_125227_RF/rois").json()["rois"]
        r = c.get("/api/recordings/20261002_125227_RF/shadow", params={"roi": "SQ_SAMPLE", "target": 55})
        assert r.status_code == 200 and r.json()["roi"] == "SQ_SAMPLE"
        assert c.get("/api/recordings/20261002_125227_RF/shadow", params={"roi": "nope", "target": 55}).status_code == 404
        assert c.get("/api/recordings/20261002_125227_RF/events.json").json()[0]["label"] == "recording_started"
        assert c.get("/api/recordings/..%2Fx/rois").status_code in (400, 404)
```

- [ ] **Step 2: Run, expect FAIL** → `cd backend && uv run python -m pytest tests/test_replay_shadow.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement** `replay_shadow.py`

```python
"""Re-run the plant estimator + shadow loop over a recorded run (Runs view). Reads telemetry.csv
(forward power, RF state) and the long-format roi_temps.csv; joins each telemetry row with the latest
reading of the chosen ROI at or before it (within 2 s, else unknown). Read-only."""

from __future__ import annotations

import bisect
import csv
from pathlib import Path
from typing import Any

from tc_power_interface.control.plant_estimator import PlantEstimator
from tc_power_interface.control.shadow_loop import ShadowLoop, plateau_c

JOIN_TOLERANCE_NS = 2 * 10**9


def recorded_rois(run_dir: Path) -> list[str]:
    path = run_dir / "roi_temps.csv"
    if not path.is_file():
        return []
    with path.open() as f:
        return sorted({r["roi"] for r in csv.DictReader(f) if r.get("roi")})


def _roi_series(run_dir: Path, roi: str) -> tuple[list[int], list[float | None]]:
    ts: list[int] = []
    vals: list[float | None] = []
    with (run_dir / "roi_temps.csv").open() as f:
        for r in csv.DictReader(f):
            if r["roi"] == roi:
                ts.append(int(r["host_timestamp_ns"]))
                vals.append(float(r["mean_c"]) if r["mean_c"] not in ("", None) else None)
    return ts, vals


def replay_shadow(run_dir: Path, *, roi: str, target_c: float, ceiling_w: float) -> dict[str, Any]:
    if roi not in recorded_rois(run_dir):
        raise FileNotFoundError(f"ROI {roi!r} not recorded in {run_dir.name}")
    rts, rvals = _roi_series(run_dir, roi)
    est, sl, points = PlantEstimator(), ShadowLoop(), []
    t0: int | None = None
    with (run_dir / "telemetry.csv").open() as f:
        for row in csv.DictReader(f):
            ns = int(row["host_timestamp_ns"])
            t0 = ns if t0 is None else t0
            k = bisect.bisect_right(rts, ns) - 1
            temp = rvals[k] if k >= 0 and ns - rts[k] <= JOIN_TOLERANCE_NS else None
            power, rf_on = float(row["forward_w"] or 0), row["rf_on"] == "True"
            before = est.grid_samples
            e = est.add((ns - t0) / 1e9, power, temp, rf_on=rf_on)
            if est.grid_samples == before:
                continue
            s = sl.step(e, temp_c=temp, power_w=power, target_c=target_c, ceiling_w=ceiling_w)
            points.append({
                "t_s": round((ns - t0) / 1e9, 2), "temp_c": temp, "k_c_per_w": e.k_c_per_w, "tau_s": e.tau_s,
                "confidence": e.confidence, "suggest_w": s.suggest_w,
                "plateau_c": plateau_c(e.t_amb_c, e.k_c_per_w, power) if e.valid and e.t_amb_c is not None else None,
            })
    return {"roi": roi, "target_c": target_c, "points": points}
```

In `app.py`: add `"has_roi_data": (d / "roi_temps.csv").is_file()` to each `list_recordings` entry. Factor the traversal check of `download_recording` into `_run_dir(run) -> Path`, which raises 400/404, and reuse it in:

```python
    @app.get("/api/recordings/{run}/rois")
    def recording_rois(run: str) -> dict[str, Any]:
        return {"rois": recorded_rois(_run_dir(run))}

    @app.get("/api/recordings/{run}/events.json")
    def recording_events(run: str) -> Any:
        path = _run_dir(run) / "events.json"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="no events for this run")
        return json.loads(path.read_text())

    @app.get("/api/recordings/{run}/shadow")
    def recording_shadow(run: str, roi: str, target: float, ceiling: float = 200.0) -> dict[str, Any]:
        try:
            return replay_shadow(_run_dir(run), roi=roi, target_c=target, ceiling_w=ceiling)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
```

- [ ] **Step 4: Run, expect PASS** → `cd backend && uv run python -m pytest tests/test_replay_shadow.py tests/test_api_recordings.py -v`

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/recording/replay_shadow.py backend/tc_power_interface/api/app.py backend/tests/test_replay_shadow.py
git commit -m "feat(api): replay endpoints (ROI list, events, shadow re-run on any recorded ROI)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Stop an auto-started recording when the generator drops (spec §3.6)

**Files:**
- Modify: `backend/tc_power_interface/api/app.py`: `_auto_log` (:310-323), `recording_start` (:1010-1025), `_on_link_dropped` (:490-498)
- Test: `backend/tests/test_api_recordings.py` (append)

- [ ] **Step 1: Write the failing tests** (append)

```python
def _wait_active(c, want=True, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if c.get("/api/recording/status").json()["active"] is want:
            return True
        time.sleep(0.05)
    return False


def test_link_drop_stops_an_auto_started_recording(tmp_path):
    # 2026-10-06: run 20261006_164701 stayed open 14+ min with no rows after the generator went offline.
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        c.app.state.controller.on_link_dropped()
        assert c.get("/api/recording/status").json() == {"active": False, "run": None}


def test_link_drop_leaves_a_manual_recording_alone(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/recording/start", json={"name": "manual", "notes": ""})
        c.app.state.controller.on_link_dropped()
        assert c.get("/api/recording/status").json()["active"] is True
```

- [ ] **Step 2: Run, expect FAIL** → `cd backend && uv run python -m pytest tests/test_api_recordings.py -v -k link_drop`. The first test fails (the recording stays active).

- [ ] **Step 3: Implement**
  - In the lifespan, next to `app.state.current_run = None`: `app.state.current_run_auto = False`.
  - In `_auto_log`, after `app.state.current_run = run_dir.name`: `app.state.current_run_auto = True`.
  - In `recording_start`: `app.state.current_run_auto = False`.
  - In `recording_stop`: reset `app.state.current_run_auto = False`.
  - At the end of `_on_link_dropped()`:

    ```python
        rec = _recorder()
        if rec.state is RecorderState.RECORDING and app.state.current_run_auto:
            rec.stop()  # the generator is gone: an auto-started run must not stay open with no rows
            app.state.current_run = None
            app.state.current_run_auto = False
    ```

- [ ] **Step 4: Run, expect PASS** → `cd backend && uv run python -m pytest tests/test_api_recordings.py tests/test_api_connect.py -v`

- [ ] **Step 5: Full backend suite, lint, types, then commit**

Run: `cd backend && uv run python -m pytest -q && uv run ruff check . && uv run mypy tc_power_interface`
Expected: all green. Fix any lint or type finding in files this plan touched before committing.

```bash
git add backend/tc_power_interface/api/app.py backend/tests/test_api_recordings.py
git commit -m "fix(recording): stop an auto-started recording when the generator link drops

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase B: Frontend pure logic (TDD)

### Task 13: Formatting and shadow-card text

**Files:**
- Create: `frontend/src/lib/cockpit/format.ts`, `frontend/src/lib/cockpit/shadowText.ts`
- Test: `frontend/src/lib/cockpit/shadowText.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { mmss } from "./format.ts";
import { confidenceSentence, shadowCard, type Shadow } from "./shadowText.ts";

const base: Shadow = { valid: true, why: null, k_c_per_w: 0.53, tau_s: 208, confidence: 0.76, t_amb_c: 23.8,
  updates: 150, suggest_w: 61.3, plateau_c: 60.9, settle_s: 300, ttt_s: 422, show: true };

test("mmss", () => {
  assert.equal(mmss(0), "0:00");
  assert.equal(mmss(422), "7:02");
});

test("confidence sentence by band, and learning", () => {
  assert.match(confidenceSentence({ ...base, valid: false, why: "learning" }), /No estimate yet/);
  assert.match(confidenceSentence({ ...base, confidence: 0.2 }), /can't be told apart/);
  assert.match(confidenceSentence({ ...base, confidence: 0.45 }), /indicative/);
  assert.match(confidenceSentence(base), /Good enough/);
});

test("to-temperature mode shows the suggestion and the difference from your power", () => {
  const c = shadowCard("target", base, 71, 55);
  assert.equal(c.label, "Shadow loop suggests");
  assert.equal(c.value, "61 W");
  assert.equal(c.sub, "−10 W vs your 71 W, toward 55 °C");
  assert.equal(c.muted, false);
});

test("ladder/fixed modes show where the part levels off, never a suggestion", () => {
  const c = shadowCard("ladder", base, 71, 55);
  assert.equal(c.label, "At your power the part levels off at");
  assert.equal(c.value, "≈ 61 °C");
  assert.equal(c.sub, "in ≈ 5:00 (within 1 °C)");
});

test("below 30 % confidence the numbers are muted; invalid shows the reason", () => {
  assert.equal(shadowCard("ladder", { ...base, confidence: 0.2, show: false }, 71, 55).muted, true);
  const c = shadowCard("target", { ...base, valid: false, why: "learning", suggest_w: null, plateau_c: null }, 71, 55);
  assert.equal(c.value, "—");
  assert.equal(c.sub, "learning…");
});
```

- [ ] **Step 2: Run, expect FAIL** → `cd frontend && node --experimental-strip-types --test src/lib/cockpit/shadowText.test.ts` → module not found.

- [ ] **Step 3: Implement**

`format.ts`:

```ts
/** m:ss for durations in seconds (cockpit timers, time to target). */
export function mmss(s: number): string {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}

/** One decimal, or an em dash for unknown (never 0 for a missing value). */
export function f1(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? "—" : x.toFixed(1);
}
```

`shadowText.ts`:

```ts
import { mmss } from "./format.ts";

/** `thermal.shadow` from GET /api/status (backend control/cockpit.py). */
export interface Shadow {
  valid: boolean;
  why: string | null;
  k_c_per_w: number | null;
  tau_s: number | null;
  confidence: number;
  t_amb_c: number | null;
  updates: number;
  suggest_w: number | null;
  plateau_c: number | null;
  settle_s: number | null;
  ttt_s: number | null;
  show: boolean;
}

export type RunModeName = "ladder" | "fixed" | "target";

export function confidenceSentence(s: Shadow): string {
  if (!s.valid) return "No estimate yet, so no suggestion.";
  if (s.confidence < 0.3) return "Low: at steady power the gain and time constant can't be told apart. A power step sharpens it.";
  if (s.confidence < 0.6) return "Firming up: treat the numbers as indicative.";
  return "Good enough to compare with what you're doing.";
}

export interface ShadowCardText { label: string; value: string; sub: string; muted: boolean }

export function shadowCard(mode: RunModeName, s: Shadow, yourW: number, targetC: number): ShadowCardText {
  const muted = !s.show;
  const why = s.why === "learning" ? "learning…" : s.why ?? "";
  if (mode === "target") {
    if (!s.valid || s.suggest_w == null) return { label: "Shadow loop suggests", value: "—", sub: why, muted };
    const d = Math.round(s.suggest_w - yourW);
    return { label: "Shadow loop suggests", value: `${Math.round(s.suggest_w)} W`,
      sub: `${d >= 0 ? "+" : "−"}${Math.abs(d)} W vs your ${Math.round(yourW)} W, toward ${targetC} °C`, muted };
  }
  const label = "At your power the part levels off at";
  if (!s.valid || s.plateau_c == null) return { label, value: "—", sub: why, muted };
  const settle = s.settle_s == null ? "" : s.settle_s === 0 ? "now" : `in ≈ ${mmss(s.settle_s)} (within 1 °C)`;
  return { label, value: `≈ ${Math.round(s.plateau_c)} °C`, sub: settle, muted };
}
```

- [ ] **Step 4: Run, expect PASS**, same command.

- [ ] **Step 5: Commit** (`git add frontend/src/lib/cockpit/format.ts frontend/src/lib/cockpit/shadowText.ts frontend/src/lib/cockpit/shadowText.test.ts`, message `feat(cockpit): shadow-card text by run mode and confidence`, with the Co-Authored-By trailer).

### Task 14: Loop gates

**Files:** Create `frontend/src/lib/cockpit/gates.ts` and `gates.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { engageAllowed, loopGates } from "./gates.ts";

const ok = { runMode: "target", controlRoi: "freehand_sample", tempStatus: "ok", replay: false,
  confidence: 0.76, watchCount: 2, interlockArmed: false };

test("five gates in a fixed order with honest text", () => {
  const g = loopGates(ok);
  assert.deepEqual(g.map((x) => x.ok), [true, true, true, true, false]);
  assert.equal(g[1].text, "freehand_sample live (stale → 0 W)");
  assert.equal(g[2].text, "Confidence 76 % (needs ≥ 60)");
  assert.equal(g[4].text, "Core interlock (not built yet)");
});

test("engage needs every gate; the interlock alone keeps it locked in v0.17", () => {
  assert.equal(engageAllowed(loopGates(ok)), false);
  assert.equal(engageAllowed(loopGates({ ...ok, interlockArmed: true })), true);
});

test("a missing ROI, a stale feed, replay or another run mode each fail their gate", () => {
  assert.equal(loopGates({ ...ok, controlRoi: null })[1].ok, false);
  assert.equal(loopGates({ ...ok, tempStatus: "not_live" })[1].ok, false);
  assert.equal(loopGates({ ...ok, replay: true })[1].ok, false);
  assert.equal(loopGates({ ...ok, runMode: "ladder" })[0].ok, false);
  assert.equal(loopGates({ ...ok, watchCount: 0 })[3].ok, false);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

```ts
/** The temperature loop's Engage gates (spec §4, D12). In v0.17 the interlock gate is always false
 *  (backend `thermal.engage.available` is false), so Engage stays locked; the backend also answers 409. */
export interface GateInput {
  runMode: string;
  controlRoi: string | null;
  tempStatus: string | undefined;
  replay: boolean;
  confidence: number;
  watchCount: number;
  interlockArmed: boolean;
}

export interface Gate { ok: boolean; text: string }

export const ENGAGE_CONFIDENCE = 0.6;

export function loopGates(i: GateInput): Gate[] {
  return [
    { ok: i.runMode === "target", text: "To-temperature mode" },
    { ok: !i.replay && !!i.controlRoi && i.tempStatus === "ok", text: `${i.controlRoi ?? "No control ROI"} live (stale → 0 W)` },
    { ok: i.confidence >= ENGAGE_CONFIDENCE, text: `Confidence ${Math.round(i.confidence * 100)} % (needs ≥ ${ENGAGE_CONFIDENCE * 100})` },
    { ok: i.watchCount > 0, text: `Cores watched (${i.watchCount})` },
    { ok: i.interlockArmed, text: i.interlockArmed ? "Core interlock armed" : "Core interlock (not built yet)" },
  ];
}

export function engageAllowed(gates: Gate[]): boolean {
  return gates.every((g) => g.ok);
}
```

- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat(cockpit): temperature-loop engage gates (locked without the core interlock)`.

### Task 15: Timeline maths

**Files:** Create `frontend/src/lib/cockpit/timeline.ts` and `timeline.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { showLevelsOffLine, tempRange, tickStep, timeWindow } from "./timeline.ts";

test("live window: last 15 min, or the whole buffer", () => {
  assert.deepEqual(timeWindow(1200, "15", 0), [300, 1200]);
  assert.deepEqual(timeWindow(400, "15", 0), [0, 400]);
  assert.deepEqual(timeWindow(1200, "all", 50), [50, 1200]);
});

test("ticks at least 56 px apart (phone-width fix from mockup v3)", () => {
  assert.equal(tickStep(900, 1300), 60);
  assert.equal(tickStep(900, 300), 300);
  assert.equal(tickStep(36000, 300), 1200);
});

test("temperature range pads by 2 °C and includes extras; ignores unknowns", () => {
  assert.deepEqual(tempRange([30.4, null, 41.2], [55]), [28, 57]);
  assert.deepEqual(tempRange([null], []), [20, 30]); // nothing known: a neutral default, not a fake value
});

test("the levels-off line only at ≥ 30 % confidence, and never in to-temperature mode", () => {
  assert.equal(showLevelsOffLine("ladder", { show: true, plateau_c: 60 }), true);
  assert.equal(showLevelsOffLine("ladder", { show: false, plateau_c: 60 }), false);
  assert.equal(showLevelsOffLine("target", { show: true, plateau_c: 60 }), false);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

```ts
export type WindowMode = "15" | "all";

export function timeWindow(tNow: number, mode: WindowMode, tFirst: number): [number, number] {
  return mode === "15" ? [Math.max(tFirst, tNow - 900), tNow] : [tFirst, tNow];
}

const STEPS = [60, 120, 300, 600, 1200];

/** Smallest tick step (s) whose spacing is at least `minPx` on a plot `widthPx` wide. */
export function tickStep(spanS: number, widthPx: number, minPx = 56): number {
  return STEPS.find((k) => (k / Math.max(spanS, 60)) * widthPx >= minPx) ?? STEPS[STEPS.length - 1];
}

export function tempRange(values: (number | null)[], extras: number[]): [number, number] {
  const known = [...values, ...extras].filter((v): v is number => v != null && Number.isFinite(v));
  if (!known.length) return [20, 30];
  return [Math.floor(Math.min(...known) - 2), Math.ceil(Math.max(...known) + 2)];
}

export function showLevelsOffLine(mode: string, s: { show: boolean; plateau_c: number | null }): boolean {
  return mode !== "target" && s.show && s.plateau_c != null;
}
```

- [ ] **Step 4: PASS. Step 5: Commit** `feat(cockpit): timeline window, tick spacing and range`.

### Task 16: Ladder bookkeeping and core warn level

**Files:** Create `frontend/src/lib/cockpit/ladder.ts` and `ladder.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { coreLevel, ladderStep, nextPlateau, parseLadder } from "./ladder.ts";

test("parseLadder: numbers from free text, positive, unique, sorted", () => {
  assert.deepEqual(parseLadder("10, 5 20;20 x -3"), [5, 10, 20]);
  assert.deepEqual(parseLadder(""), []);
});

test("ladderStep: the step you're on (1-based) and the next one", () => {
  assert.deepEqual(ladderStep([5, 10, 20], 10.4), { index: 2, next: 20 });
  assert.deepEqual(ladderStep([5, 10, 20], 0), { index: 0, next: 5 });
  assert.deepEqual(ladderStep([5, 10, 20], 20.5), { index: 3, next: null });
  assert.deepEqual(ladderStep([], 40), { index: 0, next: null });
});

test("nextPlateau needs a valid estimate", () => {
  assert.equal(nextPlateau({ valid: true, k_c_per_w: 0.5, t_amb_c: 24 }, 70), 59);
  assert.equal(nextPlateau({ valid: false, k_c_per_w: null, t_amb_c: 24 }, 70), null);
});

test("coreLevel: warn on temperature or rate; unknown is never ok", () => {
  const th = { tempC: 45, ratePerMin: 3 };
  assert.equal(coreLevel(31.9, 1.1, th), "ok");
  assert.equal(coreLevel(46, 0.2, th), "warn");
  assert.equal(coreLevel(30, 3.4, th), "warn");
  assert.equal(coreLevel(null, null, th), "unknown");
  assert.equal(coreLevel(30, null, th), "ok"); // rate not known yet, temperature fine
});
```

- [ ] **Step 2: FAIL. Step 3: Implement**

```ts
export function parseLadder(text: string): number[] {
  const n = text.split(/[^0-9.]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  return [...new Set(n)].sort((a, b) => a - b);
}

/** Which ladder step you're on (1-based; 0 = below the first) given forward power, ±1 W. */
export function ladderStep(steps: number[], fwd: number): { index: number; next: number | null } {
  const index = steps.filter((w) => fwd >= w - 1).length;
  return { index, next: steps[index] ?? null };
}

export function nextPlateau(e: { valid: boolean; k_c_per_w: number | null; t_amb_c: number | null }, watts: number): number | null {
  return e.valid && e.k_c_per_w != null && e.t_amb_c != null ? e.t_amb_c + e.k_c_per_w * watts : null;
}

export type CoreLevel = "ok" | "warn" | "unknown";

export function coreLevel(tempC: number | null, ratePerMin: number | null, th: { tempC: number; ratePerMin: number }): CoreLevel {
  if (tempC == null) return "unknown";
  return tempC >= th.tempC || (ratePerMin ?? 0) >= th.ratePerMin ? "warn" : "ok";
}
```

- [ ] **Step 4: PASS. Step 5: Commit** `feat(cockpit): ladder bookkeeping and core warn level`.

### Task 17: Live history buffer and replay parsing

**Files:** Create `frontend/src/lib/cockpit/history.ts`, `history.test.ts`, `replay.ts`, `replay.test.ts`.

- [ ] **Step 1: Failing tests**

`history.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { appendSample, type CockpitSample } from "./history.ts";

const s = (ns: number, run: string | null = "r1"): CockpitSample => ({ ns, run, fwd: 40, rev: 0.1, part: 41, watch: {}, suggest: null, tune: 20, load: 10 });

test("dedupes by telemetry timestamp, caps the length, resets on a new run", () => {
  let b: CockpitSample[] = [];
  b = appendSample(b, s(1), 3);
  b = appendSample(b, s(1), 3); // same telemetry sample re-sent by the 10 Hz websocket
  assert.equal(b.length, 1);
  for (const ns of [2, 3, 4]) b = appendSample(b, s(ns), 3);
  assert.deepEqual(b.map((x) => x.ns), [2, 3, 4]);
  b = appendSample(b, s(5, "r2"), 3);
  assert.deepEqual(b.map((x) => x.ns), [5]);
});
```

`replay.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareStats, parseTelemetryCsv, runEvents } from "./replay.ts";

const CSV = [
  "host_timestamp_ns,forward_w,reverse_w,load_w,reflected_fraction,rf_on,tune_cap_percent,load_cap_percent,setpoint_w,part_temp_c",
  "1000000000,0,0,0,0,False,20.1,10.6,,",
  "6000000000,40,0.1,39.9,0.0025,True,20.1,10.6,40,30.5",
  "11000000000,40,0.8,39.2,0.02,True,19.1,10.6,40,31.0",
].join("\n");

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
  assert.equal(st.reflHighS, 5); // the 10 s sample (2 %) holds for one 5 s interval
  assert.equal(st.rfOnS, 10);
});

test("runEvents: RF on, setpoint changes and retunes, in time order", () => {
  const ev = runEvents(parseTelemetryCsv(CSV));
  assert.deepEqual(ev.map((e) => e.text), ["RF on", "setpoint → 40 W", "retune: Tune 20.1→19.1 %, Load 10.6→10.6 %", "reflected above 1 % (0.8 W)"]);
});
```

- [ ] **Step 2: FAIL. Step 3: Implement**

`history.ts`:

```ts
/** One live cockpit sample (from /api/status), keyed by the generator telemetry timestamp. */
export interface CockpitSample {
  ns: number;
  run: string | null;
  fwd: number;
  rev: number;
  part: number | null;
  watch: Record<string, number | null>;
  suggest: number | null;
  tune: number | null;
  load: number | null;
}

/** Append if new (the websocket re-sends the same telemetry at 10 Hz); reset on a new recording run. */
export function appendSample(buf: CockpitSample[], s: CockpitSample, maxN: number): CockpitSample[] {
  const last = buf[buf.length - 1];
  if (last && last.ns === s.ns) return buf;
  const base = last && s.run !== null && last.run !== s.run ? [] : buf;
  const next = [...base, s];
  return next.length > maxN ? next.slice(next.length - maxN) : next;
}
```

`replay.ts`:

```ts
export interface ReplayRow {
  t_s: number; forward_w: number; reverse_w: number; rf_on: boolean;
  tune: number | null; load: number | null; setpoint_w: number | null; part_temp_c: number | null;
}

const num = (v: string | undefined): number | null => (v == null || v === "" ? null : Number(v));

export function parseTelemetryCsv(text: string): ReplayRow[] {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  const at = (cells: string[], name: string) => cells[cols.indexOf(name)];
  let t0: number | null = null;
  return lines.filter(Boolean).map((line) => {
    const c = line.split(",");
    const ns = Number(at(c, "host_timestamp_ns"));
    t0 ??= ns;
    return {
      t_s: (ns - t0) / 1e9, forward_w: num(at(c, "forward_w")) ?? 0, reverse_w: num(at(c, "reverse_w")) ?? 0,
      rf_on: at(c, "rf_on") === "True", tune: num(at(c, "tune_cap_percent")), load: num(at(c, "load_cap_percent")),
      setpoint_w: num(at(c, "setpoint_w")), part_temp_c: num(at(c, "part_temp_c")),
    };
  });
}

export function compareStats(rows: ReplayRow[], shadow: { t_s: number; suggest_w: number | null }[]) {
  const diffs: number[] = [];
  for (const p of shadow) {
    if (p.suggest_w == null) continue;
    const r = rows.reduce((best, x) => (Math.abs(x.t_s - p.t_s) < Math.abs(best.t_s - p.t_s) ? x : best), rows[0]);
    if (r && r.rf_on) diffs.push(Math.abs(p.suggest_w - r.forward_w));
  }
  let reflHighS = 0, rfOnS = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].t_s - rows[i - 1].t_s, r = rows[i];
    if (r.rf_on && r.forward_w > 1) {
      rfOnS += dt;
      if (r.reverse_w > 0.01 * r.forward_w) reflHighS += dt;
    }
  }
  return { meanAbsDiffW: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null, reflHighS, rfOnS };
}

export function runEvents(rows: ReplayRow[]): { t_s: number; text: string }[] {
  const ev: { t_s: number; text: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1];
    if (r.rf_on && !(p?.rf_on)) ev.push({ t_s: r.t_s, text: "RF on" });
    if (p && r.setpoint_w != null && r.setpoint_w !== p.setpoint_w) ev.push({ t_s: r.t_s, text: `setpoint → ${r.setpoint_w} W` });
    if (p && r.tune != null && p.tune != null && r.load != null && p.load != null &&
        (Math.abs(r.tune - p.tune) >= 0.5 || Math.abs(r.load - p.load) >= 0.5))
      ev.push({ t_s: r.t_s, text: `retune: Tune ${p.tune}→${r.tune} %, Load ${p.load}→${r.load} %` });
    const hi = (x?: ReplayRow) => !!x && x.forward_w > 1 && x.reverse_w > 0.01 * x.forward_w;
    if (hi(r) && !hi(p)) ev.push({ t_s: r.t_s, text: `reflected above 1 % (${r.reverse_w.toFixed(1)} W)` });
  }
  return ev;
}
```

- [ ] **Step 4: PASS. Step 5: Commit** `feat(cockpit): live history buffer and replay parsing/comparison`.

### Task 18: Types and API calls

**Files:** Modify `frontend/src/lib/telemetry.ts` (`ThermalStatus` at :61-81) and `frontend/src/lib/api.ts` (`api` object at :103). Test: append to `frontend/src/lib/api.test.ts`.

- [ ] **Step 1: Failing test** (append)

```ts
import { replayShadowPath } from "./api.ts";

test("replayShadowPath encodes the run and ROI", () => {
  assert.equal(replayShadowPath("20261002_125227_RF", "SQ SAMPLE", 55),
    "/api/recordings/20261002_125227_RF/shadow?roi=SQ%20SAMPLE&target=55");
});
```

Use the file's existing `assert`/`test` imports. Add only the new import line if `replayShadowPath` isn't already imported.

- [ ] **Step 2: FAIL** (`replayShadowPath` not exported).
- [ ] **Step 3: Implement**
  - In `telemetry.ts`, add to `ThermalStatus`:

    ```ts
      /** Cockpit (v0.17). Absent on older operators. */
      shadow?: import("./cockpit/shadowText.ts").Shadow;
      watch?: { name: string; temp_c: number | null; rate_c_per_min: number | null; status: string }[];
      run_mode?: { mode: "ladder" | "fixed" | "target"; ladder_w: number[]; fixed_w: number; fixed_min: number };
      engage?: { available: boolean; reason: string };
    ```

    Add `commanded_setpoint_w?: number | null` to the controller snapshot type in the same file.
  - In `api.ts`:

    ```ts
    export const replayShadowPath = (run: string, roi: string, target: number): string =>
      `/api/recordings/${encodeURIComponent(run)}/shadow?roi=${encodeURIComponent(roi)}&target=${target}`;
    ```

    Then add to `api`:

    ```ts
      setWatch: (names: string[]) => post("/api/thermal/watch", { names }),
      setRunMode: (m: { mode: string; ladder_w?: number[]; fixed_w?: number; fixed_min?: number }) => post("/api/run-mode", m),
      engageLoop: () => post("/api/thermal/engage"),
      recordings: async (): Promise<{ runs: { run: string; complete: boolean; size_bytes: number; has_roi_data: boolean }[] }> =>
        (await fetch(apiUrl(BASE, "/api/recordings"))).json(),
      recordingCsv: async (run: string): Promise<string> =>
        (await fetch(apiUrl(BASE, `/api/recordings/${encodeURIComponent(run)}/telemetry.csv`))).text(),
      recordingRois: async (run: string): Promise<{ rois: string[] }> =>
        (await fetch(apiUrl(BASE, `/api/recordings/${encodeURIComponent(run)}/rois`))).json(),
      replayShadow: async (run: string, roi: string, target: number) =>
        (await fetch(apiUrl(BASE, replayShadowPath(run, roi, target)))).json(),
    ```

- [ ] **Step 4: PASS** (`npm test`). **Step 5: Commit** `feat(cockpit): status types and API calls for watch, run mode, engage, replay`.

---

## Phase C: Frontend UI (verification gate: browser check against the simulator)

The components below are display glue over Tasks 13–18. Their logic is already tested, so the gate for each is: `npm run build` passes, and a headless-Chrome check against a **scratch** operator (never the lab one) passes.

Start the scratch operator once for Phase C:

```bash
cd backend && uv run python -m tc_power_interface.api.server --backend simulated --port 8011 --experiments-root /tmp/tcp-cockpit-scratch --frontend-dist ../frontend/dist
```

The flag names come from `api/server.py:21-40`. If `--frontend-dist` isn't a flag there, use `npm run dev` with the operator base set to `http://localhost:8011` instead. Rebuild with `cd frontend && npm run build` after each UI task.

### Task 19: Extract `SetpointEntry`; Dashboard unchanged

**Files:**
- Create: `frontend/src/components/cockpit/SetpointEntry.tsx`
- Modify: `frontend/src/components/RfPowerPanel.tsx` (the `setpoint-entry` + `setpoint-nudge` + hint block, lines ~113-150)

- [ ] **Step 1:** Move the JSX for the number input, Apply, the four nudge buttons and the hint line out of `RfPowerPanel` into `SetpointEntry`, verbatim. Props: `controllable, setpointInput, setSetpointInput, setpointRef, applySetpoint, nudgeSetpoint, onSetpointKey, ceilingW`. Move `SP_FINE`/`SP_COARSE` with it and export them. `RfPowerPanel` renders `<SetpointEntry … ceilingW={limits?.max_forward_w ?? null} />` in the same place. Same class names, so the CSS is untouched.
- [ ] **Step 2: Gate:** `npm run build` passes. Take a headless screenshot of the Dashboard on :8011 before and after and compare them; the setpoint box must be pixel-identical apart from live numbers. Command: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1440,1000 --virtual-time-budget=4000 --screenshot=/tmp/tcp-dash-after.png http://localhost:8011/`
- [ ] **Step 3: Commit** `refactor(ui): SetpointEntry shared by the Dashboard and the cockpit`.

### Task 20: The cockpit page (live)

**Files:**
- Create: `frontend/src/hooks/useCockpitHistory.ts`, `frontend/src/components/cockpit/{PowerDials,CockpitStrip,CockpitTimeline,ThermalColumn,RunModeColumn,WatchColumn}.tsx`, `frontend/src/pages/CockpitPage.tsx`, `frontend/src/cockpit.css`
- Modify: `frontend/src/App.tsx:162` (render `CockpitPage` instead of `ClosedLoopPage`), `frontend/src/main.tsx` (import `./cockpit.css`)

- [ ] **Step 1: `useCockpitHistory`.** Keep `CockpitSample[]` in state. On every `op.status` change, build a sample from it (`ns = status.controller.telemetry.host_timestamp_ns`, `run = status.recording.run`, `part = thermal.control_temp_c`, `watch` from `thermal.watch`, `suggest = thermal.shadow.suggest_w`, caps from telemetry) and call `appendSample(buf, s, 4 * 3600 * 2)`. That's 4 h at ~2 Hz. Return the buffer. No telemetry → no sample.
- [ ] **Step 2: `PowerDials`.** A `.gauge-grid` of four `<Gauge>`: Requested (`op.requested`), Forward, Load, Reverse. Use exactly the props `TelemetryPanel.tsx:46-74` passes (`max={op.powerCeil}`, `caution={op.fwdCaution}`, `danger={op.fwdDanger}`; Reverse `max={op.maxRefl}`, caution 50 %, danger 80 %).
- [ ] **Step 3: `CockpitStrip`.** A grid with `grid-template-areas: "meters sp match"` (CSS copied from mockup v4 `extra4.css`, `.strip4` rules), holding:
  - **meters:** `PowerDials`.
  - **sp:** header `Setpoint` with a Manual | Temp loop segmented control (local state). Manual = `<SetpointEntry …/>` plus RF ON (`btn danger`, `op.rfOn`) and RF OFF (`op.rfOff`). Temp loop = `Hold at {plan target} °C · ceiling {thermalPlan.loop_ceiling_w} W`, the `loopGates(...)` list (✓/✗) and an Engage button. Engage is `disabled={!engageAllowed(gates)}`, and its click calls `api.engageLoop()` and shows the 409 detail via `op.flash`. Both bodies sit in `.spbody { min-height: 214px }`, so switching moves nothing.
  - **match:** Tune and Load rows. Each has a label, a large `−` (`op.bumpTune(-1)`/`op.bumpLoad(-1)`), the readback (`t.tune_cap_percent.toFixed(1)`) and `+`, disabled per `!op.controllable || op.capBusy === "tune"`, the same rule as `MatchingNetworkPanel.tsx:80`. Then a reflected-% chip and a status line: `≤0.25 %` "Matched. Hold.", `<1 %` "Close: reflected below 1 %.", else "Reflected x % — retune by hand." The status line has a fixed `min-height`.
- [ ] **Step 4: `CockpitTimeline`.** A `<canvas>` drawn in a `useEffect` from the history buffer, using `timeWindow`, `tickStep`, `tempRange` and `showLevelsOffLine`. Port the mockup v4 `draw()` (scratchpad `script4.js`, function `draw`) to TS with these lanes:
  - **Temperature:** part, up to 4 watched ROIs (colours `--core`, `#f78c6c`, `#c3e88d`, `#82aaff`), and the target or levels-off dashed line.
  - **Power:** filled forward, dashed shadow suggestion only in target mode where `shadow.show`, reflected % on the right axis, and retune ticks.

  Below the canvas: the "Last 15 min | Whole run" control and a dynamic legend. "Whole run" means since this page opened or the run started, and the legend says so.
- [ ] **Step 5: Columns.**
  - **`ThermalColumn`:** control-ROI `<select>` from `thermal.available_rois` → `op.applyControlRoi`, part °C and rate (from the history), the target and `ttt_s`, the shadow card from `shadowCard(...)` with K, τ, a confidence bar and `confidenceSentence`, plus `tempStatusText` (`lib/thermalView.ts`).
  - **`RunModeColumn`:** the mode chips → `api.setRunMode`. Ladder: a step list input (`parseLadder`), the current step (`ladderStep`), the next step's plateau (`nextPlateau`) and a "Next step → N W" button that calls `op.nudgeSetpoint(N − current)`, an operator click. Fixed: W and the existing timer controls (`op.timerMin`, `op.startTimer`). Target: target and ceiling, editing the thermal plan via `op.saveThermalPlan`.
  - **`WatchColumn`:** rows from `thermal.watch` with `coreLevel` colouring (thresholds from Task 22's store, defaults 45/3), checkboxes over `available_rois` minus the control ROI, max 4 → `api.setWatch`, and drift and travel from `aid` (as in `MatchAidPanel`'s DriftBlock).
- [ ] **Step 6: `CockpitPage`.** Header row (mode chips, run name, network label, elapsed, energy), then `CockpitStrip`, `CockpitTimeline`, and a three-column grid (`ThermalColumn`, `RunModeColumn`, `WatchColumn`). The view switch is Cockpit | Runs; Runs lands in Task 21. Wire it in `App.tsx` in place of `ClosedLoopPage`. Keep `ClosedLoopPage.tsx` in the tree until Task 23 passes, then delete it in its own commit.
- [ ] **Step 7: Gate** (scratch operator on :8011, simulated backend)
  - `npm run build` passes and `npm test` is green.
  - Headless screenshot at 1440 × 1500 of the Closed-loop tab: four dials, the setpoint, Tune/Load and the timeline are all visible.
  - **Layout-shift probe.** Append a test-only script to a copy of `dist/index.html` that records `.timeline`'s `getBoundingClientRect().top`, clicks the "Temp loop" segment, switches run modes and toggles a watched ROI, then writes the max |Δtop| to `document.title`. Read it with `--dump-dom`. Expected: `0`.
  - Phone width: render inside a 390 px iframe (headless Chrome's minimum window is 500 px). Expected: no horizontal overflow.
  - Engage: in Temp loop with to-temperature mode, the button is disabled and gate 5 shows ✗.
- [ ] **Step 8: Commit** `feat(ui): closed-loop cockpit (dials, setpoint, Tune/Load, timeline, shadow, watch, run modes)`.

### Task 21: Runs (replay) view

**Files:** Create `frontend/src/components/cockpit/RunsView.tsx`. Modify `CockpitPage.tsx`.

- [ ] **Step 1:** Run list from `api.recordings()`, newest first. Each run is tagged "ROIs recorded" (`has_roi_data`) or "no ROI data — power, reflected, caps only". Opening a run:
  - `api.recordingCsv` → `parseTelemetryCsv`; `api.recordingRois` → the ROI dropdown (disabled with "no ROI data" when empty).
  - On ROI or target change, `api.replayShadow(run, roi, target)`.
  - Comparison strip from `compareStats`; event list from `runEvents`, click to jump.
  - The same `CockpitTimeline` with a scrubber and play/pause, and the future greyed. `CockpitStrip` is shown read-only (class `ro`, `pointer-events: none`) with values at the cursor.
- [ ] **Step 2: Gate.**
  - Write the real-data run from `tests/test_replay_shadow.py::_write_run` into `/tmp/tcp-cockpit-scratch`: `cd backend && uv run python -c "from pathlib import Path; import sys; sys.path.insert(0,'tests'); from test_replay_shadow import _write_run; _write_run(Path('/tmp/tcp-cockpit-scratch'))"`.
  - Open Runs: the run appears with "ROIs recorded".
  - Picking `SQ_SAMPLE` re-runs the shadow loop, and the `replayName` header shows it.
  - The comparison strip shows a number, not "—".
  - Headless screenshot.
- [ ] **Step 3: Commit** `feat(ui): Runs view — replay with ROI choice, shadow re-run, comparison and events`.

### Task 22: Core warn thresholds in Settings

**Files:** Modify `frontend/src/lib/settings_store.ts` and its test, and `frontend/src/pages/SettingsPage.tsx`.

- [ ] **Step 1: Failing test** (append to `settings_store.test.ts`)

```ts
import { cockpitThresholds, COCKPIT_KEY } from "./settings_store.ts";

test("core warn thresholds: provisional defaults, bounded", () => {
  assert.equal(COCKPIT_KEY, "tcp.cockpit.v1");
  assert.deepEqual(cockpitThresholds(null), { tempC: 45, ratePerMin: 3, provisional: true });
  assert.deepEqual(cockpitThresholds({ tempC: 500, ratePerMin: -1 }), { tempC: 150, ratePerMin: 0.1, provisional: false });
});
```

- [ ] **Step 2: FAIL. Step 3: Implement**

```ts
export const COCKPIT_KEY = "tcp.cockpit.v1";

/** Watched-core warn thresholds. The defaults are placeholders (45 °C, 3 °C/min) until set from run
 *  data. The 09-24 runaway had no core ROI on camera, so the UI marks them provisional. */
export function cockpitThresholds(v: { tempC?: number; ratePerMin?: number } | null) {
  if (!v) return { tempC: 45, ratePerMin: 3, provisional: true };
  const clamp = (x: number | undefined, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, x ?? d));
  return { tempC: clamp(v.tempC, 25, 150, 45), ratePerMin: clamp(v.ratePerMin, 0.1, 30, 3), provisional: false };
}
```

Settings page: a small "Cockpit — core warnings" panel with two number fields, saving through `storeSettings(settingsStorage(), COCKPIT_KEY, ...)`. `WatchColumn` reads `cockpitThresholds(loadSettings(...)?.value ?? null)` and shows "provisional" when `provisional`.
- [ ] **Step 4: PASS + build. Step 5: Commit** `feat(settings): core warn thresholds for the cockpit (provisional defaults)`.

### Task 23: Version, full verification, real-data end-to-end

- [ ] **Step 1:** Bump `frontend/package.json` `"version"` to `"0.17.0"` (MINOR: new feature).
- [ ] **Step 2:** Full checks:
  - `cd backend && uv run python -m pytest -q && uv run ruff check . && uv run mypy tc_power_interface`
  - `cd frontend && npm test && npm run build`

  Expected: everything green. Paste the summary lines into the task report.
- [ ] **Step 3: Real-data E2E** (data-contract rule 4) against the **real FLIR tool**, on a scratch operator, never the lab one:

```bash
cd backend && uv run python -m tc_power_interface.api.server --backend none --port 8011 --experiments-root /tmp/tcp-cockpit-e2e --flir-url http://localhost:8000
```

  With FLIR running a session:
  - `curl -s localhost:8011/api/status | python3 -m json.tool`: `thermal.roi_temps` lists the live ROIs with real `mean_c`.
  - `POST /api/thermal/roi {"name": "<a real ROI>"}` → `temp_status` is `ok` (or a real reason like `not_live`).
  - `POST /api/thermal/watch {"names": ["toroid_C"]}` → `thermal.watch[0].temp_c` is a real number, and its rate turns non-null after 60 s.
  - `POST /api/thermal/engage` → 409.
  - Print the actual output and read it. No generator is needed: power is 0, the estimator stays "learning", and that must read as learning, not healthy.
- [ ] **Step 4:** Delete `frontend/src/pages/ClosedLoopPage.tsx` and any component only it used (check with `grep -rn "ThermalHero\|calib-slot" frontend/src`). Run `npm run build` again. Commit `chore(ui): remove the superseded Closed-loop page`.
- [ ] **Step 5:** Commit the version bump (`chore(release): v0.17.0 closed-loop cockpit`). **Stop.** Report to Matt: test counts, the E2E output and screenshots. Ask before merging to main, pushing, or restarting the lab operator. Before any restart, `/api/status` must show RF off and no active recording.

---

## Out of scope (do not build here)

- Working Engage, the core interlock (RF off on core °C or °C/min), auto-retune: v0.18 and later (D12, transformer-temperature interlock spec).
- Turntable / angle schedule (chip shown disabled).
- Changes to the FLIR tool.
- Re-running the shadow loop over pre-v0.17 FLIR exports in the app (stays an offline `tools/flir` script).
