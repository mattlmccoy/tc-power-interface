# Scope Sense-Loop Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the transformer sense loop from a Siglent SDS1202X-E inside TC-POWER, fit Vrms/f0/H2/H3 per capture,
convert to core flux, auto-assign each reading to the settled commanded power level, and log it with each run.

**Architecture:** Pure units (codec, fit, flux, level tracker, flags, summary) carry all logic and are TDD'd against
fixtures captured from the 2026-10-06 sense-loop runs. A `ScopeLink` poll thread does VISA IO only; a `ScopeHub`
glues link + tracker + per-run `ScopeRecorder`; a separate FastAPI router exposes it. The scope never touches RF
control or protection (warn-only).

**Tech Stack:** Python 3.11+, numpy, pyvisa + pyvisa-py + pyusb, FastAPI; React 18 + TS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-07-scope-sense-loop-design.md`

**Conventions (all tasks):**
- Work in the worktree `TC-POWER/.claude/worktrees/scope-sense-loop` (branch `feat/scope-sense-loop`).
- Backend commands run from `backend/`: `uv run pytest …`, `uv run ruff check .`, `uv run mypy --strict tc_power_interface`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never edit `api/app.py` beyond the wiring lines in Task 10 (it is already 1114 lines).
- Red-green: run each new test and SEE it fail for the stated reason before implementing.

`M` below = `/Users/mattmccoy/GaTech Dropbox/Matthew McCoy/mattmccoy-research/research/binderjet/experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-10-06_sense-loop-double`

---

## File structure

| File | Responsibility |
|---|---|
| `backend/tc_power_interface/integration/scope_codec.py` | parse `#9` block, scale codes→V, time axis, clip, parse numeric replies (pure) |
| `backend/tc_power_interface/analysis/__init__.py` | package marker + `__all__` |
| `backend/tc_power_interface/analysis/sense_loop_fit.py` | sine + harmonic fit (pure port of `ramp_core2_fit.fit`) |
| `backend/tc_power_interface/analysis/flux.py` | `LoopGeometry`, `ScopeLimits`, `b_pk_mt`, `limit_flags` (pure) |
| `backend/tc_power_interface/analysis/scope_flags.py` | seating + detune heuristics (pure, stateful per session) |
| `backend/tc_power_interface/analysis/scope_summary.py` | per-level summary + session mT/√W fit (pure) |
| `backend/tc_power_interface/control/level_tracker.py` | setpoint/forward → level assignment (pure) |
| `backend/tc_power_interface/control/controller.py` | MODIFY: remember `last_setpoint_w`, expose in snapshot |
| `backend/tc_power_interface/recording/recorder.py` | MODIFY: `run_dir` property + `add_finalizer` hook for manifest |
| `backend/tc_power_interface/recording/scope_recorder.py` | `scope.csv`, `scope_waveforms/`, `scope_levels.csv` |
| `backend/tc_power_interface/integration/scope_link.py` | VISA open/list, `acquire_once`, poll thread |
| `backend/tc_power_interface/integration/scope_hub.py` | glue: settings, tracker, flags, per-run recorder, latest reading |
| `backend/tc_power_interface/integration/scope_settings.py` | `ScopeSettings` + JSON load/save |
| `backend/tc_power_interface/api/scope_routes.py` | `APIRouter` for `/api/scope/*` |
| `backend/tests/fixtures/scope/` | real captures + telemetry copied from `M` |
| `frontend/src/lib/scope.ts` (+ `.test.ts`) | types + pure formatting/state for the panel |
| `frontend/src/components/SenseLoopPanel.tsx` | the panel |
| `tools/scope/capture_replies.py` | hardware-gate script: record real scope replies as fixtures |

---

### Task 0: Dependencies and real fixtures

**Files:**
- Modify: `backend/pyproject.toml` (dependencies)
- Create: `backend/tests/fixtures/scope/` (copied real data)
- Create: `backend/tests/fixtures/scope/README.md`

- [ ] **Step 1: Add runtime deps** — in `backend/pyproject.toml` `dependencies = [...]`, append:

```toml
    # Scope sense-loop logging (2026-10-07): numpy for the sine fit; pyvisa + pyvisa-py (+ pyusb for USB-TMC,
    # needs libusb) so USB0::… and TCPIP0::… go through one resource string with no NI-VISA install.
    "numpy>=1.26",
    "pyvisa>=1.14",
    "pyvisa-py>=0.7",
    "pyusb>=1.2",
```

- [ ] **Step 2: Sync** — Run: `uv sync --extra dev` · Expected: resolves and installs, exit 0.

- [ ] **Step 3: Copy fixtures (captured, not invented)**

```bash
F=tests/fixtures/scope; mkdir -p $F
cp "$M/scope_loop/core2_ramp/10W/SDS00002.csv" $F/core2_10W_SDS00002.csv
cp "$M/scope_loop/core2_ramp/50W/SDS00006.csv" $F/core2_50W_SDS00006.csv
cp "$M/scope_loop/core2_ramp/90W/SDS00010.csv" $F/core2_90W_SDS00010.csv
cp "$M/scope_loop/core1/3W/SDS00001.csv"        $F/core1_3W_SDS00001.csv
cp "$M/POWERSWEEP_core2_probe_20261006_155611_RF_20261006_155611_telemetry.csv" $F/powersweep_core2_telemetry.csv
```

- [ ] **Step 4: Write `tests/fixtures/scope/README.md`**

```markdown
# Scope fixtures (captured from real data — do not hand-edit)

Source: experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-10-06_sense-loop-double/
- core2_{10,50,90}W_*.csv, core1_3W_*.csv — SDS1202X-E FW 1.3.27 front-panel CSV saves, sense loop via PHA0150.
- powersweep_core2_telemetry.csv — TC-POWER telemetry.csv of the 5→90 W ramp (setpoint was NOT logged then).

Reference fit values come from running ramp_core2_fit.py's fit() on these exact files (2026-10-07):
| file | Vrms | resid | f0 | min | max | H2 (frac) | H3 (frac) |
|---|---|---|---|---|---|---|---|
| core2_10W | 27.4295 | 0.705242 | 1.356e7 | -40 | 40 | 0.00127811 | 0.00273698 |
| core2_50W | 50.149 | 0.666169 | 1.356e7 | -70 | 72 | 0.00264559 | 0.00143736 |
| core2_90W | 68.8334 | 0.792761 | 1.356e7 | -98 | 98 | 0.00449 | 0.00213115 |
| core1_3W | 15.2429 | 0.151211 | 1.356e7 | -21.6 | 22 | 0.00191701 | 0.00023558 |

scope_replies_*/ (added in Task 12) — raw VISA replies captured live from the scope.
```

- [ ] **Step 5: Run existing suite to confirm baseline** — `uv run pytest -q` · Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock tests/fixtures/scope
git commit -m "chore(scope): numpy/pyvisa deps + real 10-06 sense-loop fixtures"
```

---

### Task 1: Scope codec (pure)

**Files:**
- Create: `backend/tc_power_interface/integration/scope_codec.py`
- Test: `backend/tests/test_scope_codec.py`

DATA-CONTRACT: the `#9` block layout and `code·VDIV/25 − OFST` scaling are from Siglent's SDS1000X-E programming
guide and are NOT yet verified on FW 1.3.27. The block tests are shape-only until Task 12 adds captured replies.
The one real check available now (verified 2026-10-07): the front-panel CSVs step by exactly VDIV/25 per code
(2 V at 50 V/div, 0.4 V at 10 V/div), but the CSV export adds ~0.1 V rounding jitter, so it confirms the STEP,
not the absolute offset to better than ±0.1 V. The exact offset is checked at the hardware gate (Task 12).

- [ ] **Step 1: Write the failing tests**

```python
"""Scope codec tests. Block tests are SHAPE-ONLY until Task 12 captures real WF? replies."""

import csv
from pathlib import Path

import numpy as np
import pytest

from tc_power_interface.integration.scope_codec import (
    ScopeCodecError,
    codes_to_volts,
    is_clipped,
    parse_number,
    parse_wf_block,
    time_axis,
)

FIX = Path(__file__).parent / "fixtures" / "scope"


def _block(codes: list[int]) -> bytes:
    payload = np.array(codes, dtype=np.int8).tobytes()
    return b"C1:WF DAT2,#9" + f"{len(payload):09d}".encode() + payload + b"\n\n"


def test_parse_wf_block_returns_int8_codes():
    out = parse_wf_block(_block([0, 1, -1, 127, -128]))
    assert out.dtype == np.int8
    assert out.tolist() == [0, 1, -1, 127, -128]


def test_parse_wf_block_rejects_missing_header():
    with pytest.raises(ScopeCodecError, match="#9"):
        parse_wf_block(b"garbage")


def test_parse_wf_block_rejects_short_payload():
    raw = b"#9000000010" + b"\x01\x02"
    with pytest.raises(ScopeCodecError, match="short"):
        parse_wf_block(raw)


def test_scaling_matches_real_50w_capture_grid():
    # Real capture: 50 V/div, offset -6 V. Steps are VDIV/25 = 2 V; the CSV export adds ~0.1 V jitter.
    volts = []
    for row in csv.reader((FIX / "core2_50W_SDS00006.csv").open()):
        try:
            volts.append(float(row[1]))
        except (ValueError, IndexError):
            continue
    v = np.array(volts)
    codes = np.round((v - 6.0) / 2.0).astype(np.int8)
    np.testing.assert_allclose(codes_to_volts(codes, vdiv=50.0, ofst=-6.0), v, atol=0.11)


def test_time_axis_centres_on_14_divisions():
    t = time_axis(1400, tdiv=1e-7, sara=1e9)
    assert t[0] == pytest.approx(-7e-7)
    assert t[1] - t[0] == pytest.approx(1e-9)


def test_is_clipped_only_at_rails():
    assert not is_clipped(np.array([-127, 0, 126], dtype=np.int8))
    assert is_clipped(np.array([0, 127], dtype=np.int8))
    assert is_clipped(np.array([-128, 0], dtype=np.int8))


@pytest.mark.parametrize(
    ("reply", "value"),
    [("5.00E+01", 50.0), ("5.00E+01V", 50.0), ("1.00E+09Sa/s", 1e9), ("-6.00E+00V\n", -6.0), ("50", 50.0)],
)
def test_parse_number_strips_units(reply, value):
    assert parse_number(reply) == pytest.approx(value)


def test_parse_number_rejects_non_numeric():
    with pytest.raises(ScopeCodecError):
        parse_number("ERR")
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_scope_codec.py -q` · Expected: FAIL, `ModuleNotFoundError: tc_power_interface.integration.scope_codec`.

- [ ] **Step 3: Implement**

```python
"""Pure codec for Siglent SDS1000X-E waveform replies (no IO).

Scaling per the SDS1000X-E programming guide: volts = code * VDIV/25 - OFST; time = -TDIV*14/2 + i/SARA.
Unverified on FW 1.3.27 until real replies are captured (see tests/fixtures/scope/README.md).
"""

from __future__ import annotations

import re

import numpy as np
from numpy.typing import NDArray

GRID_DIVS = 14
CODES_PER_DIV = 25.0
ADC_MIN = -128
ADC_MAX = 127
_NUMBER = re.compile(r"^\s*([-+]?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)")


class ScopeCodecError(ValueError):
    """A scope reply could not be parsed."""


def parse_wf_block(raw: bytes) -> NDArray[np.int8]:
    """Extract the int8 sample codes from a ``WF? DAT2`` reply (``…#9<9-digit len><bytes>``)."""
    i = raw.find(b"#9")
    if i < 0:
        raise ScopeCodecError("no #9 block header in waveform reply")
    try:
        n = int(raw[i + 2 : i + 11])
    except ValueError as exc:
        raise ScopeCodecError("bad #9 block length") from exc
    data = raw[i + 11 : i + 11 + n]
    if len(data) != n:
        raise ScopeCodecError(f"short waveform block: {len(data)} of {n} bytes")
    return np.frombuffer(data, dtype=np.int8).copy()


def codes_to_volts(codes: NDArray[np.int8], *, vdiv: float, ofst: float) -> NDArray[np.float64]:
    return codes.astype(np.float64) * (vdiv / CODES_PER_DIV) - ofst


def time_axis(n: int, *, tdiv: float, sara: float) -> NDArray[np.float64]:
    return -tdiv * GRID_DIVS / 2 + np.arange(n, dtype=np.float64) / sara


def is_clipped(codes: NDArray[np.int8]) -> bool:
    return bool(np.any(codes <= ADC_MIN) or np.any(codes >= ADC_MAX))


def parse_number(reply: str) -> float:
    """Leading float of a CHDR-OFF reply, ignoring unit suffixes (``5.00E+01V``, ``1.00E+09Sa/s``)."""
    m = _NUMBER.match(reply)
    if m is None:
        raise ScopeCodecError(f"non-numeric scope reply: {reply!r}")
    return float(m.group(1))
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_scope_codec.py -q` · Expected: all PASS.

- [ ] **Step 5: Lint/type** — `uv run ruff check . && uv run mypy --strict tc_power_interface` · Expected: clean.

- [ ] **Step 6: Commit** — `git add tc_power_interface/integration/scope_codec.py tests/test_scope_codec.py && git commit -m "feat(scope): pure SDS waveform codec (block parse, scaling, clip, numeric replies)"`

---

### Task 2: Sense-loop fit (pure port)

**Files:**
- Create: `backend/tc_power_interface/analysis/__init__.py`
- Create: `backend/tc_power_interface/analysis/sense_loop_fit.py`
- Test: `backend/tests/test_sense_loop_fit.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Fit parity with ramp_core2_fit.fit() on the real 10-06 captures (values in fixtures/scope/README.md)."""

import csv
from pathlib import Path

import numpy as np
import pytest

from tc_power_interface.analysis.sense_loop_fit import fit_sense_loop

FIX = Path(__file__).parent / "fixtures" / "scope"

# file, vrms, resid, f0, vmin, vmax, h2_frac, h3_frac  (from ramp_core2_fit.fit, 2026-10-07)
REF = [
    ("core2_10W_SDS00002.csv", 27.4295, 0.705242, 13.56e6, -40.0, 40.0, 0.00127811, 0.00273698),
    ("core2_50W_SDS00006.csv", 50.149, 0.666169, 13.56e6, -70.0, 72.0, 0.00264559, 0.00143736),
    ("core2_90W_SDS00010.csv", 68.8334, 0.792761, 13.56e6, -98.0, 98.0, 0.00449, 0.00213115),
    ("core1_3W_SDS00001.csv", 15.2429, 0.151211, 13.56e6, -21.6, 22.0, 0.00191701, 0.00023558),
]


def _load(name: str) -> tuple[np.ndarray, np.ndarray]:
    t, v = [], []
    for row in csv.reader((FIX / name).open()):
        try:
            t.append(float(row[0]))
            v.append(float(row[1]))
        except (ValueError, IndexError):
            continue
    return np.array(t), np.array(v)


@pytest.mark.parametrize(("name", "vrms", "resid", "f0", "vmin", "vmax", "h2", "h3"), REF)
def test_fit_matches_reference_script(name, vrms, resid, f0, vmin, vmax, h2, h3):
    t, v = _load(name)
    r = fit_sense_loop(t, v)
    assert r.vrms_v == pytest.approx(vrms, rel=1e-4)
    assert r.resid_v == pytest.approx(resid, rel=1e-4)
    assert r.f0_hz == pytest.approx(f0, rel=1e-6)
    assert (r.vmin_v, r.vmax_v) == (pytest.approx(vmin), pytest.approx(vmax))
    assert r.h2_pct == pytest.approx(100 * h2, rel=1e-3)
    assert r.h3_pct == pytest.approx(100 * h3, rel=1e-3)
    assert r.n == 1400


def test_fit_rejects_too_few_points():
    with pytest.raises(ValueError, match="points"):
        fit_sense_loop(np.zeros(5), np.zeros(5))
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_sense_loop_fit.py -q` · Expected: FAIL, `ModuleNotFoundError: tc_power_interface.analysis`.

- [ ] **Step 3: Implement** — `analysis/__init__.py`:

```python
"""Pure analysis of sense-loop scope captures (no IO)."""

__all__: list[str] = []
```

`analysis/sense_loop_fit.py`:

```python
"""Sine + harmonic fit of one sense-loop capture.

Port of experiments/…/2026-10-06_sense-loop-double/ramp_core2_fit.py ``fit()``: grid-search f0 over
13.50–13.62 MHz (121 points; scope timebase tolerance), LSQ sin/cos/DC, Vrms = amp/√2, residual = std of the
fit error, then a 3-harmonic LSQ at f0 for H2/H3 relative to the fundamental.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

F_LO_HZ = 13.50e6
F_HI_HZ = 13.62e6
N_GRID = 121
MIN_POINTS = 64


@dataclass(frozen=True)
class FitResult:
    vrms_v: float
    f0_hz: float
    resid_v: float
    vmin_v: float
    vmax_v: float
    h2_pct: float
    h3_pct: float
    n: int


def _lstsq(a: NDArray[np.float64], v: NDArray[np.float64]) -> NDArray[np.float64]:
    c, *_ = np.linalg.lstsq(a, v, rcond=None)
    return np.asarray(c, dtype=np.float64)


def fit_sense_loop(t: NDArray[np.float64], v: NDArray[np.float64]) -> FitResult:
    if len(t) < MIN_POINTS or len(t) != len(v):
        raise ValueError(f"need >= {MIN_POINTS} matching points, got {len(t)}/{len(v)}")
    ones = np.ones_like(t)
    best: tuple[float, float, float] | None = None
    for f0 in np.linspace(F_LO_HZ, F_HI_HZ, N_GRID):
        w = 2 * np.pi * f0 * t
        a = np.c_[np.sin(w), np.cos(w), ones]
        c = _lstsq(a, v)
        r = float(np.std(v - a @ c))
        if best is None or r < best[0]:
            best = (r, float(f0), float(np.hypot(c[0], c[1])))
    assert best is not None
    resid, f0, amp = best
    cols = [fn(2 * np.pi * k * f0 * t) for k in (1, 2, 3) for fn in (np.sin, np.cos)]
    c = _lstsq(np.c_[np.array(cols).T, ones], v)
    fund = float(np.hypot(c[0], c[1]))
    return FitResult(
        vrms_v=amp / math.sqrt(2),
        f0_hz=f0,
        resid_v=resid,
        vmin_v=float(v.min()),
        vmax_v=float(v.max()),
        h2_pct=100 * float(np.hypot(c[2], c[3])) / fund,
        h3_pct=100 * float(np.hypot(c[4], c[5])) / fund,
        n=len(t),
    )
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_sense_loop_fit.py -q` · Expected: 5 PASS.
- [ ] **Step 5: Lint/type** — `uv run ruff check . && uv run mypy --strict tc_power_interface` · Expected: clean.
- [ ] **Step 6: Commit** — `git add tc_power_interface/analysis tests/test_sense_loop_fit.py && git commit -m "feat(scope): sense-loop sine/harmonic fit, parity with ramp_core2_fit on real captures"`

---

### Task 3: Flux and hard-limit flags (pure)

**Files:**
- Create: `backend/tc_power_interface/analysis/flux.py`
- Test: `backend/tests/test_flux.py`

Evidence: A_e = 1.58e-4 m² (record:26); one-core 0.1051 mT/V and 6 mT ↔ 57 V (record:946-951); 90 W capture
68.83 V ↔ "7.2 mT" (record:1780).

- [ ] **Step 1: Write the failing tests**

```python
from tc_power_interface.analysis.flux import LoopGeometry, ScopeLimits, b_pk_mt, limit_flags

import pytest


def test_one_core_coefficient_matches_record():
    assert b_pk_mt(1.0, 13.56e6, LoopGeometry()) == pytest.approx(0.1051, rel=1e-3)


def test_90w_capture_is_7_2_mt():
    assert b_pk_mt(68.8334, 13.56e6, LoopGeometry()) == pytest.approx(7.23, abs=0.01)


def test_two_core_loop_halves_b():
    one = b_pk_mt(50.0, 13.56e6, LoopGeometry(cores_linked=1))
    two = b_pk_mt(50.0, 13.56e6, LoopGeometry(cores_linked=2))
    assert two == pytest.approx(one / 2)


def test_six_mt_stop_is_57_volts_one_core():
    assert b_pk_mt(57.11, 13.56e6, LoopGeometry()) == pytest.approx(6.0, abs=0.01)


def test_geometry_rejects_nonpositive():
    with pytest.raises(ValueError):
        LoopGeometry(turns=0)
    with pytest.raises(ValueError):
        LoopGeometry(ae_per_core_m2=0.0)


def test_limit_flags():
    lim = ScopeLimits()
    assert limit_flags(40.0, 4.2, lim) == ()
    assert limit_flags(66.0, 5.0, lim) == ("probe_warn",)
    assert limit_flags(71.0, 5.0, lim) == ("probe_hard",)
    assert limit_flags(58.0, 6.1, lim) == ("flux_stop",)
    assert limit_flags(71.0, 7.5, lim) == ("probe_hard", "flux_stop")
    assert limit_flags(71.0, None, lim) == ("probe_hard",)
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_flux.py -q` · Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
"""Sense-loop volts -> core peak flux density, and the warn-only hard-limit flags.

B_pk = √2·Vrms / (N·n_cores·A_e·2πf) = Vrms / (π√2·f·N·n_cores·A_e). Peak, cross-section average; the
toroid inner edge runs ~1.3x higher. ~±5 % uncertainty (lead resonant rise, air term). Source: transformer
record 2026-09-24 (A_e line 26; 0.1051 mT/V and 6 mT stop lines 946-951).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

AE_FAIR_RITE_5967003801_M2 = 1.58e-4


@dataclass(frozen=True)
class LoopGeometry:
    turns: int = 1
    cores_linked: int = 1
    ae_per_core_m2: float = AE_FAIR_RITE_5967003801_M2

    def __post_init__(self) -> None:
        if self.turns < 1 or self.cores_linked < 1 or self.ae_per_core_m2 <= 0:
            raise ValueError("turns, cores_linked and ae_per_core_m2 must be positive")


@dataclass(frozen=True)
class ScopeLimits:
    """Defaults: PHA0150 practice (65/70 V rms) and the record's 6 mT stop. All warn-only."""

    probe_warn_v: float = 65.0
    probe_hard_v: float = 70.0
    flux_stop_mt: float = 6.0


def b_pk_mt(vrms_v: float, f_hz: float, geo: LoopGeometry) -> float:
    area = geo.turns * geo.cores_linked * geo.ae_per_core_m2
    return 1000.0 * vrms_v / (math.pi * math.sqrt(2) * f_hz * area)


def limit_flags(vrms_v: float, b_mt: float | None, lim: ScopeLimits) -> tuple[str, ...]:
    flags: list[str] = []
    if vrms_v >= lim.probe_hard_v:
        flags.append("probe_hard")
    elif vrms_v >= lim.probe_warn_v:
        flags.append("probe_warn")
    if b_mt is not None and b_mt >= lim.flux_stop_mt:
        flags.append("flux_stop")
    return tuple(flags)
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_flux.py -q` · Expected: PASS.
- [ ] **Step 5: Lint/type**, then **Step 6: Commit** — `git commit -m "feat(scope): volts->B_pk flux with loop geometry and warn-only limit flags"`

---

### Task 4: Level tracker (pure)

**Files:**
- Create: `backend/tc_power_interface/control/level_tracker.py`
- Test: `backend/tests/test_level_tracker.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Level assignment: commanded setpoint, settled only. Real-data test pins the 1.0 W default tolerance."""

import csv
from pathlib import Path

import pytest

from tc_power_interface.control.level_tracker import LevelState, LevelTracker

FIX = Path(__file__).parent / "fixtures" / "scope"


def test_rf_off_and_no_setpoint():
    lt = LevelTracker()
    assert lt.update(0.0, setpoint_w=50, forward_w=0.0, rf_on=False).state is LevelState.RF_OFF
    assert lt.update(1.0, setpoint_w=None, forward_w=50.5, rf_on=True).state is LevelState.NO_SETPOINT


def test_settles_after_settle_s_then_assigns():
    lt = LevelTracker(tol_w=1.0, settle_s=3.0)
    assert lt.update(0.0, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.SETTLING
    assert lt.update(2.9, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.SETTLING
    a = lt.update(3.0, setpoint_w=50, forward_w=50.6, rf_on=True)
    assert a.state is LevelState.ASSIGNED and a.level_w == 50


def test_off_setpoint_resets_settle_clock():
    lt = LevelTracker(tol_w=1.0, settle_s=3.0)
    lt.update(0.0, setpoint_w=50, forward_w=50.5, rf_on=True)
    assert lt.update(2.0, setpoint_w=50, forward_w=60.5, rf_on=True).state is LevelState.OFF_SETPOINT
    assert lt.update(4.0, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.SETTLING
    assert lt.update(7.0, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.ASSIGNED


def test_setpoint_change_restarts_settling():
    lt = LevelTracker(tol_w=1.0, settle_s=3.0)
    lt.update(0.0, setpoint_w=50, forward_w=50.5, rf_on=True)
    lt.update(3.0, setpoint_w=50, forward_w=50.5, rf_on=True)
    assert lt.update(3.5, setpoint_w=60, forward_w=60.4, rf_on=True).state is LevelState.SETTLING


def test_real_powersweep_offsets_fit_default_tolerance_not_half_watt():
    # 10-06 ramp: forward reads +0.4..+0.6 W over the nominal 5/10/20…90 W step (setpoint was not logged;
    # the nominal steps are the operator's folder labels). Default 1.0 W must accept every plateau row;
    # 0.5 W would reject some — the reason the spec default changed.
    steps = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90]
    rows = list(csv.DictReader((FIX / "powersweep_core2_telemetry.csv").open()))
    fwd = [float(r["forward_w"]) for r in rows if float(r["forward_w"]) > 1.0]
    dev = [min(abs(p - s) for s in steps) for p in fwd]
    plateau = [d for d in dev if d <= 1.5]  # exclude ramp-transition rows
    assert len(plateau) > 600
    assert max(plateau) <= LevelTracker().tol_w
    assert any(d > 0.5 for d in plateau)


def test_rejects_bad_config():
    with pytest.raises(ValueError):
        LevelTracker(tol_w=0)
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_level_tracker.py -q` · Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
"""Assign readings to the commanded power level once forward power has settled near it.

TC-POWER cannot read the setpoint back (docs/protocol.md:67), so the level is the LAST setpoint TC-POWER
commanded. Front-panel changes show up as OFF_SETPOINT, never as a forced level.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class LevelState(enum.Enum):
    ASSIGNED = "assigned"
    SETTLING = "settling"
    OFF_SETPOINT = "off_setpoint"
    NO_SETPOINT = "no_setpoint"
    RF_OFF = "rf_off"


@dataclass(frozen=True)
class LevelAssignment:
    level_w: float | None
    state: LevelState


class LevelTracker:
    def __init__(self, tol_w: float = 1.0, settle_s: float = 3.0) -> None:
        if tol_w <= 0 or settle_s < 0:
            raise ValueError("tol_w must be > 0 and settle_s >= 0")
        self.tol_w = tol_w
        self.settle_s = settle_s
        self._since: float | None = None
        self._sp: float | None = None
        self.current = LevelAssignment(None, LevelState.RF_OFF)

    def _set(self, a: LevelAssignment) -> LevelAssignment:
        self.current = a
        return a

    def update(
        self, t_s: float, *, setpoint_w: float | None, forward_w: float | None, rf_on: bool
    ) -> LevelAssignment:
        if not rf_on or forward_w is None:
            self._since = None
            return self._set(LevelAssignment(None, LevelState.RF_OFF))
        if setpoint_w is None:
            self._since = None
            return self._set(LevelAssignment(None, LevelState.NO_SETPOINT))
        if abs(forward_w - setpoint_w) > self.tol_w:
            self._since = None
            return self._set(LevelAssignment(None, LevelState.OFF_SETPOINT))
        if self._since is None or self._sp != setpoint_w:
            self._since, self._sp = t_s, setpoint_w
        if t_s - self._since >= self.settle_s:
            return self._set(LevelAssignment(setpoint_w, LevelState.ASSIGNED))
        return self._set(LevelAssignment(None, LevelState.SETTLING))
```

- [ ] **Step 4: Run to verify pass** — Expected: PASS. **Step 5: Lint/type.** **Step 6: Commit** — `git commit -m "feat(scope): level tracker (settled commanded setpoint, 1.0 W default from real telemetry)"`

---

### Task 5: Controller remembers the last commanded setpoint

**Files:**
- Modify: `backend/tc_power_interface/control/controller.py` (`__init__`, `estop` ~line 221, `detach_device` ~238, `set_setpoint` ~410, `snapshot` ~501)
- Test: `backend/tests/test_controller_setpoint_memory.py`

- [ ] **Step 1: Write the failing tests** (same construction as `tests/test_controller.py:21` `make_controller`;
  `tests/` is not a package, so duplicate the 3-line helper rather than importing it)

```python
from tc_power_interface.control.controller import Controller
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport


def make_controller() -> Controller:
    c = Controller(CxnDevice(SimulatedCxnTransport()), limits=SafetyLimits(), poll_interval_s=0.01)
    c.connect()  # as in test_controller.py:90 before set_setpoint
    return c


def test_snapshot_reports_none_before_any_setpoint():
    c = make_controller()
    assert c.snapshot()["last_setpoint_w"] is None


def test_set_setpoint_is_remembered_clamped():
    c = make_controller()
    applied = c.set_setpoint(50)
    assert c.snapshot()["last_setpoint_w"] == applied


def test_estop_records_zero_and_detach_clears():
    c = make_controller()
    c.set_setpoint(50)
    c.estop()
    assert c.snapshot()["last_setpoint_w"] == 0
    c.detach_device()
    assert c.snapshot()["last_setpoint_w"] is None
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL with `KeyError: 'last_setpoint_w'`.

- [ ] **Step 3: Implement** — add in `__init__` next to the other published state:

```python
        self._last_setpoint_w: int | None = None  # last setpoint TC-POWER commanded (no device readback)
```

in `set_setpoint`, after `self.device.set_setpoint(clamped)` (still inside the method):

```python
        with self._lock:
            self._last_setpoint_w = clamped
```

in `estop`, after the `dev.set_setpoint(0)` try-block succeeds (inside `try:` after the call):

```python
                    with self._lock:
                        self._last_setpoint_w = 0
```

in `detach_device`, where `self.device = None` is set:

```python
            self._last_setpoint_w = None
```

in `snapshot()`, read it under the existing lock (`sp = self._last_setpoint_w`) and add `"last_setpoint_w": sp,`
to the returned dict.

- [ ] **Step 4: Run new + full suite** — `uv run pytest -q` · Expected: all PASS.
- [ ] **Step 5: Lint/type. Step 6: Commit** — `git commit -m "feat(controller): remember last commanded setpoint in snapshot (no device readback exists)"`

---

### Task 6: Seating and detune heuristics (pure)

**Files:**
- Create: `backend/tc_power_interface/analysis/scope_flags.py`
- Test: `backend/tests/test_scope_flags.py`

Both are HEURISTICS (spec): seating = resid or H2 > 3× the level's baseline median (first 5 valid readings at
that level); detune = Vrms/√level dropped > 5 % versus the value ~30 s earlier at the same level.

- [ ] **Step 1: Write the failing tests**

```python
from tc_power_interface.analysis.scope_flags import SessionFlagger


def _feed(f, t, level, vrms, resid=0.7, h2=0.3):
    return f.update(t_s=t, level_w=level, vrms_v=vrms, resid_v=resid, h2_pct=h2)


def test_no_flags_while_building_baseline_and_when_steady():
    f = SessionFlagger()
    for i in range(10):
        assert _feed(f, float(i), 50, 50.1) == ()


def test_seating_flag_when_residual_jumps():
    f = SessionFlagger()
    for i in range(5):
        _feed(f, float(i), 50, 50.1, resid=0.7)
    assert "seating" in _feed(f, 6.0, 50, 45.0, resid=2.5)


def test_detune_flag_when_v_per_sqrtw_falls_over_30s():
    f = SessionFlagger()
    for i in range(0, 31):
        out = _feed(f, float(i), 90, 68.8 if i < 30 else 64.0)
    assert "detune" in out


def test_unassigned_readings_never_flag():
    f = SessionFlagger()
    assert _feed(f, 0.0, None, 10.0, resid=99) == ()
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```python
"""Per-session HEURISTIC flags for low-reading clips (seating) and thermal detune. Not calibrated."""

from __future__ import annotations

import math
import statistics
from collections import deque
from dataclasses import dataclass, field

BASELINE_N = 5
SEATING_FACTOR = 3.0
DETUNE_WINDOW_S = 30.0
DETUNE_DROP = 0.05


@dataclass
class _LevelHistory:
    resid: list[float] = field(default_factory=list)
    h2: list[float] = field(default_factory=list)
    vps: deque[tuple[float, float]] = field(default_factory=deque)  # (t, Vrms/√W)


class SessionFlagger:
    def __init__(self) -> None:
        self._levels: dict[float, _LevelHistory] = {}

    def update(
        self, *, t_s: float, level_w: float | None, vrms_v: float, resid_v: float, h2_pct: float
    ) -> tuple[str, ...]:
        if level_w is None or level_w <= 0:
            return ()
        h = self._levels.setdefault(level_w, _LevelHistory())
        flags: list[str] = []
        if len(h.resid) >= BASELINE_N:
            if resid_v > SEATING_FACTOR * statistics.median(h.resid[:BASELINE_N]) or h2_pct > (
                SEATING_FACTOR * statistics.median(h.h2[:BASELINE_N])
            ):
                flags.append("seating")
        else:
            h.resid.append(resid_v)
            h.h2.append(h2_pct)
        vps = vrms_v / math.sqrt(level_w)
        h.vps.append((t_s, vps))
        while h.vps and t_s - h.vps[0][0] > DETUNE_WINDOW_S:
            h.vps.popleft()
        t0, v0 = h.vps[0]
        if t_s - t0 >= DETUNE_WINDOW_S - 1.0 and vps < (1 - DETUNE_DROP) * v0:
            flags.append("detune")
        return tuple(flags)
```

- [ ] **Step 4: Pass. Step 5: Lint/type. Step 6: Commit** — `git commit -m "feat(scope): heuristic seating and detune flags per level"`

---

### Task 7: Per-level summary + session mT/√W fit (pure)

**Files:**
- Create: `backend/tc_power_interface/analysis/scope_summary.py`
- Test: `backend/tests/test_scope_summary.py`

- [ ] **Step 1: Write the failing tests**

```python
import math

import pytest

from tc_power_interface.analysis.scope_summary import session_mt_per_sqrtw, summarize_levels


def _row(level, vrms, b, valid=True, f0=13.56e6):
    return {"level_w": level, "vrms_v": vrms, "b_pk_mt": b, "f0_hz": f0, "h2_pct": 0.3, "h3_pct": 0.2,
            "valid": valid}


def test_summary_groups_valid_assigned_rows_only():
    rows = [_row(50, 50.0, 5.25), _row(50, 50.2, 5.27), _row(50, 99.0, 9.9, valid=False), _row(None, 30.0, 3.1)]
    (s,) = summarize_levels(rows)
    assert s.level_w == 50 and s.n == 2
    assert s.vrms_median_v == pytest.approx(50.1)
    assert s.v_per_sqrtw == pytest.approx(50.1 / math.sqrt(50))


def test_session_fit_uses_only_levels_at_or_above_10w():
    rows = [_row(5, 99.0, 9.9)] + [_row(w, 0, 0.75 * math.sqrt(w)) for w in (10, 40, 90)]
    k = session_mt_per_sqrtw(summarize_levels(rows), min_level_w=10.0)
    assert k == pytest.approx(0.75)


def test_session_fit_none_without_eligible_levels():
    assert session_mt_per_sqrtw(summarize_levels([_row(5, 10, 1.0)]), min_level_w=10.0) is None
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```python
"""Per-level summary of sense-loop readings and a session mT/√W fit (levels >= 10 W; meter ±20 % below)."""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LevelSummary:
    level_w: float
    n: int
    vrms_median_v: float
    vrms_iqr_v: float
    f0_median_hz: float
    h2_median_pct: float
    h3_median_pct: float
    v_per_sqrtw: float
    b_median_mt: float | None


def _iqr(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    q = statistics.quantiles(xs, n=4)
    return q[2] - q[0]


def summarize_levels(rows: Iterable[Mapping[str, Any]]) -> list[LevelSummary]:
    groups: dict[float, list[Mapping[str, Any]]] = defaultdict(list)
    for r in rows:
        if r.get("valid") and r.get("level_w") is not None:
            groups[float(r["level_w"])].append(r)
    out = []
    for level in sorted(groups):
        g = groups[level]
        v = [float(r["vrms_v"]) for r in g]
        b = [float(r["b_pk_mt"]) for r in g if r.get("b_pk_mt") is not None]
        med = statistics.median(v)
        out.append(
            LevelSummary(
                level_w=level,
                n=len(g),
                vrms_median_v=med,
                vrms_iqr_v=_iqr(v),
                f0_median_hz=statistics.median(float(r["f0_hz"]) for r in g),
                h2_median_pct=statistics.median(float(r["h2_pct"]) for r in g),
                h3_median_pct=statistics.median(float(r["h3_pct"]) for r in g),
                v_per_sqrtw=med / math.sqrt(level),
                b_median_mt=statistics.median(b) if b else None,
            )
        )
    return out


def session_mt_per_sqrtw(levels: list[LevelSummary], *, min_level_w: float = 10.0) -> float | None:
    """LSQ slope of B vs √P through the origin over eligible levels. Session-local; drifts with heating."""
    pts = [(math.sqrt(s.level_w), s.b_median_mt) for s in levels if s.level_w >= min_level_w and s.b_median_mt]
    if not pts:
        return None
    return sum(x * y for x, y in pts if y is not None) / sum(x * x for x, _ in pts)
```

- [ ] **Step 4: Pass. Step 5: Lint/type. Step 6: Commit** — `git commit -m "feat(scope): per-level summary and session mT/sqrtW fit"`

---

### Task 8: Recorder hooks + ScopeRecorder

**Files:**
- Modify: `backend/tc_power_interface/recording/recorder.py` (`__init__`, `stop()` before manifest, new property)
- Create: `backend/tc_power_interface/recording/scope_recorder.py`
- Test: `backend/tests/test_scope_recorder.py`

- [ ] **Step 1: Write the failing tests**

```python
import csv
import json
from pathlib import Path

from tc_power_interface.recording.recorder import TelemetryRecorder
from tc_power_interface.recording.scope_recorder import SCOPE_FIELDS, ScopeRecorder

FIX = Path(__file__).parent / "fixtures" / "scope"


def _reading(level, vrms, valid=True):
    r = {k: None for k in SCOPE_FIELDS}
    r.update(host_timestamp_ns=1, level_w=level, level_state="assigned" if level else "settling", vrms_v=vrms,
             f0_hz=13.56e6, resid_v=0.7, vmin_v=-vrms * 1.4, vmax_v=vrms * 1.4, h2_pct=0.3, h3_pct=0.2,
             b_pk_mt=0.105 * vrms, valid=valid, flags="")
    return r


def test_recorder_finalizer_files_are_in_manifest(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("r", {})
    assert rec.run_dir == run

    def fin(d: Path) -> list[str]:
        (d / "extra.csv").write_text("x\n")
        return ["extra.csv"]

    rec.add_finalizer(fin)
    rec.stop()
    man = json.loads((run / "manifest.json").read_text())
    assert "extra.csv" in man["checksums"]
    assert rec.run_dir is None


def test_scope_recorder_writes_rows_waveform_and_levels(tmp_path):
    sr = ScopeRecorder(tmp_path)
    t = [-7e-7 + i * 1e-9 for i in range(3)]
    sr.record(_reading(50, 50.0), t=t, v=[1.0, 2.0, 3.0], header={"Vertical Scale": "CH1:+5.0E+01"})
    sr.record(_reading(50, 50.2), t=t, v=[1.0, 2.0, 3.0], header={})
    sr.record(_reading(None, 10.0), t=t, v=[0.0, 0.0, 0.0], header={})
    names = sr.finalize()
    assert set(names) == {"scope.csv", "scope_levels.csv", "scope_session.json", "scope_waveforms/50W.csv"}
    rows = list(csv.DictReader((tmp_path / "scope.csv").open()))
    assert len(rows) == 3
    lv = list(csv.DictReader((tmp_path / "scope_levels.csv").open()))
    assert lv[0]["level_w"] == "50.0" and lv[0]["n"] == "2"
    wf = (tmp_path / "scope_waveforms" / "50W.csv").read_text().splitlines()
    assert wf[-1].startswith("-6.98")  # time column first, scope-CSV layout
    assert "Second,Value" in wf


def test_waveform_saved_once_per_level_and_invalid_never(tmp_path):
    sr = ScopeRecorder(tmp_path)
    sr.record(_reading(50, 50.0, valid=False), t=[0.0], v=[9.0], header={})
    sr.record(_reading(50, 50.0), t=[0.0], v=[1.0], header={})
    sr.record(_reading(50, 50.0), t=[0.0], v=[2.0], header={})
    sr.finalize()
    assert (tmp_path / "scope_waveforms" / "50W.csv").read_text().strip().endswith("1.0")
```

- [ ] **Step 2: Run to verify failure** — Expected: `ImportError` for `scope_recorder` / `AttributeError: run_dir`.

- [ ] **Step 3a: Implement recorder hooks** — in `TelemetryRecorder.__init__` add
  `self._finalizers: list[Callable[[Path], list[str]]] = []` (import `Callable` from `collections.abc`); add:

```python
    @property
    def run_dir(self) -> Path | None:
        """The active run directory, or None when idle."""
        return self._dir if self.state is RecorderState.RECORDING else None

    def add_finalizer(self, fn: Callable[[Path], list[str]]) -> None:
        """Register a callback run at stop(), before the manifest; returned file names (relative to the run
        dir) are checksummed into the manifest. A failing finalizer is logged and recorded, never raised."""
        self._finalizers.append(fn)
```

and in `stop()`, immediately before `(run_dir / "events.json").write_text(...)`:

```python
        extra_files: list[str] = []
        for fn in self._finalizers:
            try:
                extra_files.extend(fn(run_dir))
            except Exception as exc:  # noqa: BLE001 - a broken finalizer must not lose the run
                logger.exception("recorder finalizer failed")
                self.event("finalizer_failed", {"error": str(exc)})
```

then replace the inline `"checksums": {...}` literal in `manifest` with a typed variable built first:

```python
        checksums: dict[str, str] = {
            "metadata.json": _sha256(run_dir / "metadata.json"),
            "events.json": _sha256(run_dir / "events.json"),
            "telemetry.csv": _sha256(run_dir / "telemetry.csv"),
        }
        for name in extra_files:
            checksums[name] = _sha256(run_dir / name)
```

and use `"checksums": checksums,` in the manifest dict.

- [ ] **Step 3b: Implement `scope_recorder.py`**

```python
"""Write sense-loop readings into the active run dir: scope.csv (every reading), one raw waveform per settled
level (scope_waveforms/<level>W.csv, scope CSV layout), and scope_levels.csv at finalize.

Writes happen on the scope poll thread (1-3 Hz), never on the controller thread.
"""

from __future__ import annotations

import csv
import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any, TextIO

from tc_power_interface.analysis.scope_summary import session_mt_per_sqrtw, summarize_levels

SCOPE_FIELDS = [
    "host_timestamp_ns", "level_w", "level_state", "setpoint_w", "forward_w", "reverse_w",
    "tune_cap_percent", "load_cap_percent", "vrms_v", "f0_hz", "resid_v", "vmin_v", "vmax_v",
    "h2_pct", "h3_pct", "b_pk_mt", "attn", "vdiv", "ofst", "sara", "clipped", "valid", "flags",
]
LEVEL_FIELDS = [
    "level_w", "n", "vrms_median_v", "vrms_iqr_v", "f0_median_hz", "h2_median_pct", "h3_median_pct",
    "v_per_sqrtw", "b_median_mt",
]


def _level_name(level: float) -> str:
    return f"{level:g}W.csv"


class ScopeRecorder:
    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        self._lock = threading.Lock()
        self._file: TextIO | None = (self.run_dir / "scope.csv").open("w", newline="")
        self._writer = csv.DictWriter(self._file, fieldnames=SCOPE_FIELDS, extrasaction="ignore")
        self._writer.writeheader()
        self._rows: list[dict[str, Any]] = []
        self._saved_levels: set[float] = set()
        self._files = ["scope.csv"]

    def record(
        self, reading: Mapping[str, Any], *, t: Sequence[float], v: Sequence[float], header: Mapping[str, str]
    ) -> None:
        with self._lock:
            if self._file is None:
                return
            row = {k: reading.get(k) for k in SCOPE_FIELDS}
            self._writer.writerow(row)
            self._file.flush()
            self._rows.append(row)
            level = reading.get("level_w")
            if reading.get("valid") and level is not None and float(level) not in self._saved_levels:
                self._saved_levels.add(float(level))
                self._write_waveform(float(level), t, v, header)

    def _write_waveform(
        self, level: float, t: Sequence[float], v: Sequence[float], header: Mapping[str, str]
    ) -> None:
        d = self.run_dir / "scope_waveforms"
        d.mkdir(exist_ok=True)
        name = _level_name(level)
        with (d / name).open("w", newline="") as fh:
            w = csv.writer(fh)
            for k, val in header.items():
                w.writerow([k, val])
            w.writerow(["Second", "Value"])
            for ti, vi in zip(t, v, strict=True):
                w.writerow([f"{ti:.6E}", repr(float(vi))])
        self._files.append(f"scope_waveforms/{name}")

    def finalize(self) -> list[str]:
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None
            levels = summarize_levels(self._rows)
            with (self.run_dir / "scope_levels.csv").open("w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=LEVEL_FIELDS)
                w.writeheader()
                for s in levels:
                    w.writerow(asdict(s))
            session = {
                "mt_per_sqrtw": session_mt_per_sqrtw(levels, min_level_w=10.0),
                "min_level_w": 10.0,
                "note": "LSQ of B vs sqrt(P) through origin; session-local, drifts with heating; meter ±20 % < 10 W",
            }
            (self.run_dir / "scope_session.json").write_text(json.dumps(session, indent=2))
            return [*self._files, "scope_levels.csv", "scope_session.json"]
```

  Note on the waveform test's last line: `repr(1.0)` is `"1.0"`; the `t` column uses `%.6E` like the scope.

- [ ] **Step 4: Run new + full suite** — `uv run pytest -q` · Expected: all PASS (existing recorder tests unchanged).
- [ ] **Step 5: Lint/type. Step 6: Commit** — `git commit -m "feat(scope): ScopeRecorder + recorder finalizer hook (scope files in the run manifest)"`

---

### Task 9: ScopeLink — VISA acquisition + poll thread

**Files:**
- Create: `backend/tc_power_interface/integration/scope_settings.py`
- Create: `backend/tc_power_interface/integration/scope_link.py`
- Test: `backend/tests/test_scope_link.py`

- [ ] **Step 1: Write the failing tests** (fake VISA resource built from the REAL 50 W capture)

```python
import csv
import time
from pathlib import Path

import numpy as np
import pytest

from tc_power_interface.integration.scope_link import ScopeLink, acquire_once
from tc_power_interface.integration.scope_settings import ScopeSettings, load_settings, save_settings

FIX = Path(__file__).parent / "fixtures" / "scope"


def _real_codes() -> bytes:
    v = []
    for row in csv.reader((FIX / "core2_50W_SDS00006.csv").open()):
        try:
            v.append(float(row[1]))
        except (ValueError, IndexError):
            continue
    codes = np.round((np.array(v) - 6.0) / 2.0).astype(np.int8).tobytes()  # 50 V/div, offset -6 V
    return b"C1:WF DAT2,#9" + f"{len(codes):09d}".encode() + codes + b"\n\n"


class FakeScope:
    def __init__(self, fail_after: int | None = None) -> None:
        self.replies = {"C1:ATTN?": "50", "C1:VDIV?": "5.00E+01V", "C1:OFST?": "-6.00E+00V",
                        "TDIV?": "1.00E-07S", "SARA?": "1.00E+09Sa/s"}
        self.writes: list[str] = []
        self.reads = 0
        self.fail_after = fail_after
        self.closed = False

    def write(self, cmd: str) -> int:
        self.writes.append(cmd)
        return len(cmd)

    def query(self, cmd: str) -> str:
        return self.replies[cmd]

    def read_raw(self) -> bytes:
        self.reads += 1
        if self.fail_after is not None and self.reads > self.fail_after:
            raise OSError("usb stall")
        return _real_codes()

    def close(self) -> None:
        self.closed = True


def test_acquire_once_reproduces_real_capture():
    cap = acquire_once(FakeScope(), channel=1)
    assert (cap.attn, cap.vdiv, cap.ofst, cap.sara) == (50.0, 50.0, -6.0, 1e9)
    assert len(cap.volts) == 1400 and not cap.clipped
    assert cap.volts.min() == pytest.approx(-70.0) and cap.volts.max() == pytest.approx(72.0)


def test_never_writes_settings_to_the_scope():
    fake = FakeScope()
    acquire_once(fake, channel=1)
    forbidden = ("VDIV ", "TDIV ", "OFST ", "TRMD", "ATTN ")
    assert not any(w.startswith(f) or f" {f}" in w for w in fake.writes for f in forbidden)


def test_link_produces_readings_and_reports_errors_without_raising():
    got = []
    fake = FakeScope(fail_after=2)
    link = ScopeLink(opener=lambda _r: fake, on_reading=got.append, backoff_s=0.05)
    link.start(ScopeSettings(resource="USB0::fake", poll_interval_s=0.01))
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and link.status()["error"] is None:
        time.sleep(0.01)
    link.stop()
    assert fake.writes[0] == "CHDR OFF"
    assert len(got) >= 2
    assert got[0].fit.vrms_v == pytest.approx(50.149, rel=1e-3)
    assert "usb stall" in (link.status()["error"] or "")


def test_settings_roundtrip_and_defaults(tmp_path):
    s = load_settings(tmp_path)
    assert s.resource == "" and s.geometry.cores_linked == 1 and s.tol_w == 1.0
    save_settings(tmp_path, ScopeSettings(resource="TCPIP0::1.2.3.4::INSTR", core_label="core 1"))
    s2 = load_settings(tmp_path)
    assert s2.resource == "TCPIP0::1.2.3.4::INSTR" and s2.core_label == "core 1"
```

- [ ] **Step 2: Run to verify failure** — Expected: `ModuleNotFoundError`.

- [ ] **Step 3a: Implement `scope_settings.py`**

```python
"""Persisted scope settings (experiments_root/scope_settings.json). No calibration constants live here —
only the loop geometry the flux formula needs and the warn-only limits."""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

from tc_power_interface.analysis.flux import LoopGeometry, ScopeLimits

logger = logging.getLogger(__name__)
FILENAME = "scope_settings.json"


@dataclass(frozen=True)
class ScopeSettings:
    resource: str = ""
    channel: int = 1
    probe_attn: float = 50.0  # must match the PHA0150 range switch; checked against ATTN?
    core_label: str = "core 2"
    geometry: LoopGeometry = field(default_factory=LoopGeometry)
    limits: ScopeLimits = field(default_factory=ScopeLimits)
    tol_w: float = 1.0
    settle_s: float = 3.0
    poll_interval_s: float = 0.2


def settings_from_dict(d: dict[str, Any]) -> ScopeSettings:
    base = ScopeSettings()
    geo = LoopGeometry(**{**asdict(base.geometry), **d.get("geometry", {})})
    lim = ScopeLimits(**{**asdict(base.limits), **d.get("limits", {})})
    flat = {k: v for k, v in d.items() if k not in ("geometry", "limits") and hasattr(base, k)}
    return replace(base, geometry=geo, limits=lim, **flat)


def load_settings(root: Path) -> ScopeSettings:
    p = Path(root) / FILENAME
    if not p.exists():
        return ScopeSettings()
    try:
        return settings_from_dict(json.loads(p.read_text()))
    except (ValueError, TypeError) as exc:
        logger.warning("ignoring bad %s: %s", p, exc)
        return ScopeSettings()


def save_settings(root: Path, s: ScopeSettings) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / FILENAME).write_text(json.dumps(asdict(s), indent=2))
```

- [ ] **Step 3b: Implement `scope_link.py`**

```python
"""Read-only SDS1202X-E link: open a VISA resource (USB0::… or TCPIP0::…), pull one waveform per cycle,
fit it, and hand a Reading to a callback. Never writes scope settings; never touches RF control.
Errors are reported in status() and retried with backoff; they never propagate to the caller."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol, cast

import numpy as np
from numpy.typing import NDArray

from tc_power_interface.analysis.sense_loop_fit import FitResult, fit_sense_loop
from tc_power_interface.integration.scope_codec import (
    codes_to_volts, is_clipped, parse_number, parse_wf_block, time_axis,
)
from tc_power_interface.integration.scope_settings import ScopeSettings

logger = logging.getLogger(__name__)


class ScopeResource(Protocol):
    def write(self, cmd: str) -> Any: ...
    def query(self, cmd: str) -> str: ...
    def read_raw(self) -> bytes: ...
    def close(self) -> None: ...


Opener = Callable[[str], ScopeResource]


def open_visa(resource: str) -> ScopeResource:
    import pyvisa  # local import: optional at test time

    rm = pyvisa.ResourceManager("@py")
    res = cast(Any, rm.open_resource(resource))
    res.timeout = 5000
    res.chunk_size = 4 * 1024 * 1024
    return cast(ScopeResource, res)


def list_visa_resources() -> list[str]:
    import pyvisa

    return list(pyvisa.ResourceManager("@py").list_resources())


@dataclass(frozen=True)
class Capture:
    codes: NDArray[np.int8]
    volts: NDArray[np.float64]
    t: NDArray[np.float64]
    attn: float
    vdiv: float
    ofst: float
    tdiv: float
    sara: float
    clipped: bool


@dataclass(frozen=True)
class Reading:
    host_timestamp_ns: int
    capture: Capture
    fit: FitResult | None


def acquire_once(res: ScopeResource, *, channel: int) -> Capture:
    ch = f"C{channel}"
    attn = parse_number(res.query(f"{ch}:ATTN?"))
    vdiv = parse_number(res.query(f"{ch}:VDIV?"))
    ofst = parse_number(res.query(f"{ch}:OFST?"))
    tdiv = parse_number(res.query("TDIV?"))
    sara = parse_number(res.query("SARA?"))
    res.write(f"{ch}:WF? DAT2")
    codes = parse_wf_block(res.read_raw())
    return Capture(
        codes=codes, volts=codes_to_volts(codes, vdiv=vdiv, ofst=ofst),
        t=time_axis(len(codes), tdiv=tdiv, sara=sara),
        attn=attn, vdiv=vdiv, ofst=ofst, tdiv=tdiv, sara=sara, clipped=is_clipped(codes),
    )


class ScopeLink:
    def __init__(
        self, *, opener: Opener = open_visa, on_reading: Callable[[Reading], None], backoff_s: float = 2.0
    ) -> None:
        self._opener = opener
        self._on_reading = on_reading
        self._backoff_s = backoff_s
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._status: dict[str, Any] = {"running": False, "connected": False, "error": None,
                                        "last_ns": None, "rate_hz": None}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._status)

    def _set(self, **kw: Any) -> None:
        with self._lock:
            self._status.update(kw)

    def start(self, settings: ScopeSettings) -> None:
        self.stop()
        self._stop.clear()
        self._set(running=True, error=None)
        self._thread = threading.Thread(target=self._run, args=(settings,), name="tcp-scope", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None
        self._set(running=False, connected=False)

    def _run(self, s: ScopeSettings) -> None:
        while not self._stop.is_set():
            res: ScopeResource | None = None
            try:
                res = self._opener(s.resource)
                res.write("CHDR OFF")
                self._set(connected=True, error=None)
                last = time.monotonic()
                while not self._stop.is_set():
                    cap = acquire_once(res, channel=s.channel)
                    fit = None if cap.clipped else fit_sense_loop(cap.t, cap.volts)
                    now = time.monotonic()
                    self._set(last_ns=time.time_ns(), rate_hz=round(1.0 / max(now - last, 1e-6), 2))
                    last = now
                    self._on_reading(Reading(time.time_ns(), cap, fit))
                    self._stop.wait(s.poll_interval_s)
            except Exception as exc:  # noqa: BLE001 - VISA/USB errors are varied; report and retry
                logger.warning("scope link error: %s", exc)
                self._set(connected=False, error=f"{type(exc).__name__}: {exc}")
            finally:
                if res is not None:
                    try:
                        res.close()
                    except Exception:  # noqa: BLE001
                        pass
            self._stop.wait(self._backoff_s)
```

- [ ] **Step 4: Run new + full suite** — Expected: PASS. **Step 5: Lint/type.**
- [ ] **Step 6: Commit** — `git commit -m "feat(scope): read-only VISA scope link with backoff + persisted settings"`

---

### Task 10: ScopeHub + API router + wiring

**Files:**
- Create: `backend/tc_power_interface/integration/scope_hub.py`
- Create: `backend/tc_power_interface/api/scope_routes.py`
- Modify: `backend/tc_power_interface/api/app.py` — lifespan (after `recorder = TelemetryRecorder(...)` ~line 252), shutdown (~line 416), `_status_payload` (~line 517), router include before static mount (~line 1108)
- Test: `backend/tests/test_api_scope.py`

- [ ] **Step 1: Write the failing tests**

```python
import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app
from tests.test_scope_link import FakeScope


def _app(tmp_path, monkeypatch):
    import tc_power_interface.integration.scope_hub as hub_mod

    monkeypatch.setattr(hub_mod, "open_visa", lambda _r: FakeScope())
    return create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)


def test_status_has_scope_block_with_no_data_when_disconnected(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        sc = c.get("/api/status").json()["scope"]
        assert sc["status"]["connected"] is False
        assert sc["latest"] is None  # never zeros


def test_connect_streams_readings_and_records_into_run(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        assert c.post("/api/scope/settings", json={"resource": "USB0::fake"}).status_code == 200
        assert c.post("/api/scope/connect").status_code == 200
        r = c.post("/api/recording/start", json={"name": "scope-test"})  # app.py:1010, RecordingStartRequest
        assert r.status_code == 200
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and c.get("/api/status").json()["scope"]["latest"] is None:
            time.sleep(0.05)
        latest = c.get("/api/status").json()["scope"]["latest"]
        assert abs(latest["vrms_v"] - 50.149) < 0.05
        assert latest["level_state"] in ("rf_off", "no_setpoint")
        c.post("/api/recording/stop")
        c.post("/api/scope/disconnect")
    runs = [p for p in tmp_path.iterdir() if p.is_dir()]
    assert (runs[0] / "scope.csv").exists() and (runs[0] / "scope_levels.csv").exists()


def test_attn_mismatch_is_flagged(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        c.post("/api/scope/settings", json={"resource": "USB0::fake", "probe_attn": 500})
        c.post("/api/scope/connect")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and c.get("/api/status").json()["scope"]["latest"] is None:
            time.sleep(0.05)
        assert "attn_mismatch" in c.get("/api/status").json()["scope"]["latest"]["flags"]
        c.post("/api/scope/disconnect")
```

- [ ] **Step 2: Run to verify failure** — Expected: `KeyError: 'scope'` / 404.

- [ ] **Step 3a: Implement `scope_hub.py`**

```python
"""Glue between the scope link, level tracker, flags, and the per-run ScopeRecorder.

The controller listener calls on_snapshot() every telemetry poll (keeps level settling at telemetry rate);
the scope thread calls on_reading(). Neither path ever commands the generator."""

from __future__ import annotations

import math
import threading
import time
from pathlib import Path
from typing import Any

from tc_power_interface.analysis.flux import b_pk_mt, limit_flags
from tc_power_interface.analysis.scope_flags import SessionFlagger
from tc_power_interface.control.level_tracker import LevelTracker
from tc_power_interface.integration.scope_link import Reading, ScopeLink, list_visa_resources, open_visa
from tc_power_interface.integration.scope_settings import ScopeSettings, load_settings, save_settings
from tc_power_interface.recording.recorder import TelemetryRecorder
from tc_power_interface.recording.scope_recorder import ScopeRecorder


class ScopeHub:
    def __init__(self, root: Path, recorder: TelemetryRecorder) -> None:
        self.root = Path(root)
        self.recorder = recorder
        self.settings = load_settings(self.root)
        self._lock = threading.Lock()
        self._tracker = LevelTracker(self.settings.tol_w, self.settings.settle_s)
        self._flagger = SessionFlagger()
        self._ctx: dict[str, Any] = {}
        self._latest: dict[str, Any] | None = None
        self._run: ScopeRecorder | None = None
        self.link = ScopeLink(opener=lambda r: open_visa(r), on_reading=self.on_reading)
        recorder.add_finalizer(self._finalize_run)

    # --- settings / connection ---
    def update_settings(self, s: ScopeSettings) -> None:
        with self._lock:
            self.settings = s
            self._tracker = LevelTracker(s.tol_w, s.settle_s)
        save_settings(self.root, s)

    def connect(self) -> None:
        if not self.settings.resource:
            raise ValueError("set a VISA resource first")
        self.link.start(self.settings)

    def disconnect(self) -> None:
        self.link.stop()

    @staticmethod
    def resources() -> list[str]:
        return list_visa_resources()

    # --- inputs ---
    def on_snapshot(self, snap: dict[str, Any]) -> None:
        t = snap.get("telemetry") or {}
        a = self._tracker.update(
            time.monotonic(), setpoint_w=snap.get("last_setpoint_w"),
            forward_w=t.get("forward_w"), rf_on=bool(t.get("rf_on")),
        )
        with self._lock:
            self._ctx = {"setpoint_w": snap.get("last_setpoint_w"), "level_w": a.level_w,
                         "level_state": a.state.value,
                         **{k: t.get(k) for k in ("forward_w", "reverse_w", "tune_cap_percent", "load_cap_percent")}}

    def on_reading(self, r: Reading) -> None:
        s = self.settings
        cap, fit = r.capture, r.fit
        with self._lock:
            ctx = dict(self._ctx) or {"level_w": None, "level_state": "rf_off"}
        b = None if fit is None else b_pk_mt(fit.vrms_v, fit.f0_hz, s.geometry)
        flags: list[str] = []
        if cap.clipped:
            flags.append("clipped")
        if not math.isclose(cap.attn, s.probe_attn, rel_tol=1e-6):
            flags.append("attn_mismatch")
        if fit is not None:
            flags += limit_flags(fit.vrms_v, b, s.limits)
            flags += self._flagger.update(t_s=time.monotonic(), level_w=ctx.get("level_w"),
                                          vrms_v=fit.vrms_v, resid_v=fit.resid_v, h2_pct=fit.h2_pct)
        reading: dict[str, Any] = {
            "host_timestamp_ns": r.host_timestamp_ns, **ctx,
            "vrms_v": None if fit is None else fit.vrms_v, "f0_hz": None if fit is None else fit.f0_hz,
            "resid_v": None if fit is None else fit.resid_v, "vmin_v": float(cap.volts.min()),
            "vmax_v": float(cap.volts.max()), "h2_pct": None if fit is None else fit.h2_pct,
            "h3_pct": None if fit is None else fit.h3_pct, "b_pk_mt": b, "attn": cap.attn,
            "vdiv": cap.vdiv, "ofst": cap.ofst, "sara": cap.sara, "clipped": cap.clipped,
            "valid": fit is not None and "attn_mismatch" not in flags, "flags": ";".join(flags),
        }
        run_dir = self.recorder.run_dir
        with self._lock:
            self._latest = reading
            if run_dir is not None and (self._run is None or self._run.run_dir != run_dir):
                self._run = ScopeRecorder(run_dir)
            run = self._run
        if run_dir is not None:
            for f in flags:
                if f in ("probe_warn", "probe_hard", "flux_stop", "clipped", "attn_mismatch"):
                    self.recorder.event(f"scope_{f}", {"vrms_v": reading["vrms_v"], "b_pk_mt": b})
        if run is not None:
            header = {"Vertical Scale": f"CH{s.channel}:{cap.vdiv:+E}", "Vertical Offset": f"CH{s.channel}:{cap.ofst:+E}",
                      "Probe": f"{cap.attn:g}X", "Core": s.core_label}
            run.record(reading, t=cap.t.tolist(), v=cap.volts.tolist(), header=header)

    def _finalize_run(self, run_dir: Path) -> list[str]:
        with self._lock:
            run, self._run = self._run, None
        if run is None or run.run_dir != run_dir:
            return []
        return run.finalize()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            latest = None if self._latest is None else dict(self._latest)
        st = self.link.status()
        if not st["connected"]:
            latest = None  # no data is shown as no data, never as stale or zero values
        return {"status": st, "latest": latest, "settings": _settings_dict(self.settings)}


def _settings_dict(s: ScopeSettings) -> dict[str, Any]:
    from dataclasses import asdict

    return asdict(s)
```

  `recorder.event()` appends unconditionally (recorder.py), so the hub only calls it while a run is active.

- [ ] **Step 3b: Implement `api/scope_routes.py`**

```python
"""/api/scope/* — settings, connect/disconnect, VISA resource discovery. Read-only w.r.t. the generator."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, cast

from fastapi import APIRouter, HTTPException, Request

from tc_power_interface.integration.scope_hub import ScopeHub
from tc_power_interface.integration.scope_settings import settings_from_dict

router = APIRouter(prefix="/api/scope")


def _hub(request: Request) -> ScopeHub:
    return cast(ScopeHub, request.app.state.scope_hub)


@router.get("")
def scope_status(request: Request) -> dict[str, Any]:
    return _hub(request).snapshot()


@router.get("/resources")
def scope_resources(request: Request) -> dict[str, Any]:
    try:
        return {"resources": _hub(request).resources()}
    except Exception as exc:  # noqa: BLE001 - VISA backend missing / libusb absent
        raise HTTPException(503, f"VISA unavailable: {exc}") from exc


@router.post("/settings")
def scope_settings(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    hub = _hub(request)
    cur = asdict(hub.settings)
    merged_in = {
        **cur, **body,
        "geometry": {**cur["geometry"], **body.get("geometry", {})},
        "limits": {**cur["limits"], **body.get("limits", {})},
    }
    try:
        merged = settings_from_dict(merged_in)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    hub.update_settings(merged)
    return hub.snapshot()


@router.post("/connect")
def scope_connect(request: Request) -> dict[str, Any]:
    try:
        _hub(request).connect()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return _hub(request).snapshot()


@router.post("/disconnect")
def scope_disconnect(request: Request) -> dict[str, Any]:
    _hub(request).disconnect()
    return _hub(request).snapshot()
```


- [ ] **Step 3c: Wire into `app.py`** (only these lines):
  - import: `from tc_power_interface.api.scope_routes import router as scope_router` and
    `from tc_power_interface.integration.scope_hub import ScopeHub`
  - in lifespan after `recorder = TelemetryRecorder(experiments_root)`:
    ```python
        scope_hub = ScopeHub(experiments_root, recorder)
        app.state.scope_hub = scope_hub
    ```
  - after the `controller.add_listener(... recorder.record ...)` registration (~line 327):
    `controller.add_listener(scope_hub.on_snapshot)`
  - in the lifespan `finally:` FIRST line: `app.state.scope_hub.disconnect()`
  - in `_status_payload()` dict: `"scope": app.state.scope_hub.snapshot(),`
  - before the static-frontend mount: `app.include_router(scope_router)`

- [ ] **Step 4: Run new + full suite** — `uv run pytest -q` · Expected: all PASS.
- [ ] **Step 5: Lint/type. Step 6: Commit** — `git commit -m "feat(scope): ScopeHub, /api/scope router, status + recording wiring (warn-only)"`

---

### Task 11: Frontend — types, pure formatting, Sense loop panel

**Files:**
- Create: `frontend/src/lib/scope.ts`, `frontend/src/lib/scope.test.ts`
- Create: `frontend/src/components/SenseLoopPanel.tsx`
- Modify: `frontend/src/lib/telemetry.ts` (`Status` gets `scope?: ScopeStatus`)
- Modify: `frontend/src/lib/api.ts` (`api.scope*` calls)
- Modify: `frontend/src/pages/DashboardPage.tsx` (mount after `<TimerPanel …/>`)

- [ ] **Step 1: Write the failing test** `frontend/src/lib/scope.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { flagLabel, levelRows, scopeHeadline } from "./scope.ts";
import type { ScopeReading, ScopeStatus } from "./scope.ts";

const base: ScopeReading = {
  host_timestamp_ns: 1, level_w: 50, level_state: "assigned", setpoint_w: 50, forward_w: 50.5,
  vrms_v: 50.149, f0_hz: 13.56e6, resid_v: 0.67, vmin_v: -70, vmax_v: 72, h2_pct: 0.26, h3_pct: 0.14,
  b_pk_mt: 5.27, attn: 50, flags: "", valid: true,
};

test("scopeHeadline: no data is never shown as zeros", () => {
  const st = { status: { connected: false, error: "OSError: usb stall" }, latest: null } as unknown as ScopeStatus;
  assert.equal(scopeHeadline(st).vrms, "—");
  assert.match(scopeHeadline(st).state, /no data/);
  assert.match(scopeHeadline(st).state, /usb stall/);
});

test("scopeHeadline: formats a live reading", () => {
  const st = { status: { connected: true, error: null, rate_hz: 2.1 }, latest: base } as unknown as ScopeStatus;
  const h = scopeHeadline(st);
  assert.equal(h.vrms, "50.1 V");
  assert.equal(h.b, "5.27 mT");
  assert.equal(h.f0, "13.560 MHz");
  assert.equal(h.level, "50 W");
});

test("flagLabel: hard flags are loud", () => {
  assert.equal(flagLabel("flux_stop").severity, "danger");
  assert.equal(flagLabel("probe_warn").severity, "caution");
  assert.equal(flagLabel("seating").severity, "caution");
});

test("levelRows: accumulates per level from readings, ignores invalid/unassigned", () => {
  const rows = levelRows([base, { ...base, vrms_v: 50.3 }, { ...base, valid: false }, { ...base, level_w: null }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].level_w, 50);
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npm test` · Expected: FAIL, cannot find `./scope.ts`.

- [ ] **Step 3: Implement `frontend/src/lib/scope.ts`**

```ts
export interface ScopeReading {
  host_timestamp_ns: number;
  level_w: number | null;
  level_state: string;
  setpoint_w: number | null;
  forward_w: number | null;
  vrms_v: number | null;
  f0_hz: number | null;
  resid_v: number | null;
  vmin_v: number;
  vmax_v: number;
  h2_pct: number | null;
  h3_pct: number | null;
  b_pk_mt: number | null;
  attn: number;
  flags: string;
  valid: boolean;
}

export interface ScopeStatus {
  status: { running?: boolean; connected: boolean; error: string | null; rate_hz?: number | null };
  latest: ScopeReading | null;
  settings: Record<string, unknown>;
}

const DASH = "—";

export function scopeHeadline(st: ScopeStatus | undefined) {
  const r = st?.latest;
  if (!st || !st.status.connected || !r) {
    const why = st?.status.error ? ` · ${st.status.error}` : "";
    return { state: `scope: no data${why}`, vrms: DASH, b: DASH, f0: DASH, pkpk: DASH, h2: DASH, level: DASH };
  }
  return {
    state: `scope: live${st.status.rate_hz ? ` · ${st.status.rate_hz} Hz` : ""}`,
    vrms: r.vrms_v == null ? DASH : `${r.vrms_v.toFixed(1)} V`,
    b: r.b_pk_mt == null ? DASH : `${r.b_pk_mt.toFixed(2)} mT`,
    f0: r.f0_hz == null ? DASH : `${(r.f0_hz / 1e6).toFixed(3)} MHz`,
    pkpk: `${(r.vmax_v - r.vmin_v).toFixed(0)} V`,
    h2: r.h2_pct == null ? DASH : `${r.h2_pct.toFixed(2)} %`,
    level: r.level_w == null ? r.level_state.replace("_", " ") : `${r.level_w} W`,
  };
}

const FLAGS: Record<string, { text: string; severity: "danger" | "caution" }> = {
  flux_stop: { text: "Flux at/above stop limit", severity: "danger" },
  probe_hard: { text: "Probe at/above 70 V rms hard limit", severity: "danger" },
  probe_warn: { text: "Probe above 65 V rms", severity: "caution" },
  clipped: { text: "Waveform clipped — reading invalid", severity: "danger" },
  attn_mismatch: { text: "Scope probe ×N ≠ setting", severity: "danger" },
  seating: { text: "Residual/H2 jumped — check clip seating", severity: "caution" },
  detune: { text: "V/√W falling at constant power — detune?", severity: "caution" },
};

export function flagLabel(f: string) {
  return FLAGS[f] ?? { text: f, severity: "caution" as const };
}

export interface LevelRow { level_w: number; n: number; vrms_median_v: number; b_median_mt: number | null }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function levelRows(readings: ScopeReading[]): LevelRow[] {
  const by = new Map<number, ScopeReading[]>();
  for (const r of readings) {
    if (!r.valid || r.level_w == null || r.vrms_v == null) continue;
    by.set(r.level_w, [...(by.get(r.level_w) ?? []), r]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([level_w, rs]) => {
    const bs = rs.map((r) => r.b_pk_mt).filter((b): b is number => b != null);
    return { level_w, n: rs.length, vrms_median_v: median(rs.map((r) => r.vrms_v as number)),
      b_median_mt: bs.length ? median(bs) : null };
  });
}
```

- [ ] **Step 4: Run to verify pass** — `npm test` · Expected: PASS (all existing + 4 new).

- [ ] **Step 5: API calls** — in `lib/api.ts` `api` object add:

```ts
  scopeResources: async (): Promise<{ resources: string[] }> =>
    (await fetch(apiUrl(BASE, "/api/scope/resources"))).json(),
  scopeSettings: (body: Record<string, unknown>) => post("/api/scope/settings", body),
  scopeConnect: () => post("/api/scope/connect"),
  scopeDisconnect: () => post("/api/scope/disconnect"),
```

  In `lib/telemetry.ts` `Status`: add `scope?: ScopeStatus;` with `import type { ScopeStatus } from "./scope.ts";`.

- [ ] **Step 6: Panel** `components/SenseLoopPanel.tsx` (presentational; state lives in the panel, readings
  accumulate from the status prop; NOT unit-testable beyond `lib/scope.ts` — verified in the browser in Step 8)

```tsx
import { useEffect, useRef, useState } from "react";

import { api, detail } from "../lib/api.ts";
import { flagLabel, levelRows, scopeHeadline } from "../lib/scope.ts";
import type { ScopeReading, ScopeStatus } from "../lib/scope.ts";

export function SenseLoopPanel({ scope }: { scope: ScopeStatus | undefined }) {
  const h = scopeHeadline(scope);
  const [resource, setResource] = useState<string>(String(scope?.settings?.resource ?? ""));
  const [found, setFound] = useState<string[]>([]);
  const [msg, setMsg] = useState<string>("");
  const seen = useRef<ScopeReading[]>([]);
  const latest = scope?.latest;
  useEffect(() => {
    if (latest && seen.current.at(-1)?.host_timestamp_ns !== latest.host_timestamp_ns) {
      seen.current = [...seen.current.slice(-2000), latest];
    }
  }, [latest]);
  const flags = (latest?.flags ?? "").split(";").filter(Boolean).map(flagLabel);
  const run = async (p: Promise<Response>) => {
    const r = await p;
    setMsg(r.ok ? "" : await detail(r));
  };
  return (
    <section className="panel">
      <h2>Sense loop (scope)</h2>
      <div className="hint mono">{h.state}</div>
      <div className="ramp-actions">
        <label className="ramp-field" style={{ flex: "1 1 260px" }}>
          <span>VISA resource</span>
          <input list="scope-resources" value={resource} onChange={(e) => setResource(e.target.value)}
            placeholder="USB0::0xF4EC::…::INSTR or TCPIP0::<ip>::INSTR" />
          <datalist id="scope-resources">{found.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        <button className="btn" onClick={async () => setFound((await api.scopeResources()).resources ?? [])}>Find</button>
        {scope?.status.running ? (
          <button className="btn" onClick={() => run(api.scopeDisconnect())}>Disconnect</button>
        ) : (
          <button className="btn" onClick={async () => { await run(api.scopeSettings({ resource })); await run(api.scopeConnect()); }}>Connect</button>
        )}
      </div>
      {msg && <div className="hint">{msg}</div>}
      <div className="mono">Vrms {h.vrms} · B {h.b} · f0 {h.f0} · pk-pk {h.pkpk} · H2 {h.h2} · level {h.level}</div>
      {flags.map((f) => (
        <div key={f.text} className={f.severity === "danger" ? "banner fault" : "banner warn"}>{f.text}</div>
      ))}
      <table className="mono">
        <thead><tr><th>Level</th><th>n</th><th>Vrms (median)</th><th>B (mT)</th></tr></thead>
        <tbody>
          {levelRows(seen.current).map((r) => (
            <tr key={r.level_w}><td>{r.level_w} W</td><td>{r.n}</td><td>{r.vrms_median_v.toFixed(1)}</td>
              <td>{r.b_median_mt?.toFixed(2) ?? "—"}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

  Classes `banner fault` / `banner warn` are the existing ones (`styles.css:91-92`). Loop-geometry / limit settings editing:
  add a `<details>` block with number inputs for `turns`, `cores_linked`, `probe_attn`, `core_label`,
  `probe_warn_v`, `probe_hard_v`, `flux_stop_mt` that POSTs `api.scopeSettings({geometry:{…}, limits:{…}, …})`
  on a Save button — same input pattern as `TimerPanel`.

- [ ] **Step 7: Mount** — in `hooks/useOperator.ts` next to `const timer = status?.timer;` (line 426) add
  `const scope = status?.scope;` and add `scope` to the returned object (line ~792, beside `timer`). In
  `pages/DashboardPage.tsx` import the panel and add after `<TimerPanel … />`: `<SenseLoopPanel scope={op.scope} />`.

- [ ] **Step 8: Verify** — `npm test && npm run build` · Expected: tests PASS, `tsc` clean, vite build OK.
  Then browser check (not unit-testable): run backend `uv run tcp-serve` (simulated) + `npm run dev`, open the
  dashboard, confirm the panel shows "scope: no data", Find returns a list or a readable VISA error, and nothing
  else on the page moved. Screenshot as evidence.

- [ ] **Step 9: Version bump + commit** — bump `frontend/package.json` to `0.17.0`;
  `git commit -m "feat(ui): Sense loop panel (live Vrms/B/f0, per-level table, loud flags); v0.17.0"`

---

### Task 12: Hardware gate (real scope over USB) — required before "done"

**Files:**
- Create: `tools/scope/capture_replies.py`
- Create: `backend/tests/fixtures/scope/scope_replies_<date>/` (captured)
- Modify: `backend/tests/test_scope_codec.py` (add real-reply test), `README.md` (feature row + USB setup)

- [ ] **Step 1: Confirm the scope enumerates** — macOS: `ioreg -p IOUSB -l -w0 | grep -c '"idVendor" = 62700'`
  (0xF4EC) · Expected: ≥ 1. Windows: Device Manager shows a USB Test and Measurement Device. If 0: the cable must be
  in the scope's rear **USB Device** (square B) port, not the front USB host port; check with a data cable.

- [ ] **Step 2: Write `tools/scope/capture_replies.py`** (read-only queries; saves raw replies)

```python
"""Capture raw SDS1202X-E replies as test fixtures. Read-only: only queries, never sets.
Usage: uv run python ../tools/scope/capture_replies.py <VISA resource> <out_dir>"""

import json
import sys
import time
from pathlib import Path

import pyvisa

res_name, out = sys.argv[1], Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
rm = pyvisa.ResourceManager("@py")
print("resources:", rm.list_resources())
s = rm.open_resource(res_name)
s.timeout = 5000
s.chunk_size = 4 * 1024 * 1024
s.write("CHDR OFF")
replies = {q: s.query(q) for q in ("*IDN?", "C1:ATTN?", "C1:VDIV?", "C1:OFST?", "TDIV?", "SARA?")}
(out / "replies.json").write_text(json.dumps(replies, indent=2))
t0 = time.monotonic()
for i in range(10):
    s.write("C1:WF? DAT2")
    (out / f"wf_{i}.bin").write_bytes(s.read_raw())
dt = (time.monotonic() - t0) / 10
print(json.dumps(replies, indent=2), f"\nseconds per waveform read: {dt:.3f}")
s.close()
```

- [ ] **Step 3: Capture** — with RF OFF first (no hazard; loop reads noise), then at 10 W with the probe on core 2:
  `uv run python ../tools/scope/capture_replies.py "<resource>" tests/fixtures/scope/scope_replies_20261007_rfoff`
  and `…_10W`. At 10 W, ALSO save a front-panel CSV of the same screen (the old way) for comparison.

- [ ] **Step 4: Real-reply test (red then green)** — add to `test_scope_codec.py`:

```python
REAL = FIX / "scope_replies_20261007_10W"


@pytest.mark.skipif(not REAL.exists(), reason="hardware fixture not captured yet")
def test_real_reply_scaling_matches_front_panel_csv():
    import json
    from tc_power_interface.analysis.sense_loop_fit import fit_sense_loop
    rep = json.loads((REAL / "replies.json").read_text())
    codes = parse_wf_block((REAL / "wf_0.bin").read_bytes())
    v = codes_to_volts(codes, vdiv=parse_number(rep["C1:VDIV?"]), ofst=parse_number(rep["C1:OFST?"]))
    t = time_axis(len(codes), tdiv=parse_number(rep["TDIV?"]), sara=parse_number(rep["SARA?"]))
    ours = fit_sense_loop(t, v).vrms_v
    panel = _load_panel_csv(REAL / "front_panel.csv")  # write helper: same loader as test_sense_loop_fit._load
    assert ours == pytest.approx(fit_sense_loop(*panel).vrms_v, rel=0.03)  # separate captures, same steady state
```

  If the replies' format differs from the parser (e.g. `ATTN?` reply text, block header), fix `scope_codec.py`
  under this failing test, then remove "SHAPE-ONLY" from the codec test docstring and update the fixture README.

- [ ] **Step 5: Live app run** — `uv run tcp-serve --backend serial …` (as usual), connect the scope from the
  panel, record a short 10 → 20 → 30 W step run. Read `scope.csv`, `scope_levels.csv`, `scope_waveforms/` and
  print them. Check: levels 10/20/30 assigned after ~3 s each; Vrms at 10 W within ~3 % of 27.4 V × (today's
  network) — i.e. compare to the same-session front-panel CSV, not to 10-06; read rate recorded in the README.

- [ ] **Step 6: README** — add a row to the feature table: "Scope sense-loop logging (`integration/scope_*`,
  `analysis/`) — tested; hardware-verified <date> over USB at <rate> Hz". Add a "Scope (USB)" setup note:
  macOS `brew install libusb`; Windows NI-VISA or libusb driver; resource string examples.

- [ ] **Step 7: Full verification** — backend `uv run pytest -q && uv run ruff check . && uv run mypy --strict tc_power_interface`;
  frontend `npm test && npm run build`. Expected: all green.

- [ ] **Step 8: Commit** — `git commit -m "test(scope): real SDS1202X-E reply fixtures + hardware-verified scaling; docs"`

---

## Spec coverage self-check

| Spec item | Task |
|---|---|
| USB + LAN via one VISA string | 9 (open_visa @py), 12 |
| Fit parity Vrms/f0/resid/pk/H2/H3 | 2 |
| Settled commanded setpoint, unassigned reasons | 4, 5, 10 |
| Flux from volts every reading, geometry settings | 3, 9 (settings), 10 |
| ATTN mismatch warning | 10 |
| scope.csv / scope_levels.csv / scope_session.json (≥10 W fit) / waveforms / manifest | 7, 8 |
| Flags: probe, flux, clipped, seating, detune; events.json; warn-only | 3, 6, 10, 11 |
| No data ≠ zeros | 10 (`latest=None`), 11 (`scopeHeadline`) |
| Never touches RF / never writes scope settings | 9 (test), 10 (no controller calls) |
| UI panel | 11 |
| Hardware gate | 12 |
