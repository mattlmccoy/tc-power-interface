"""Sine + harmonic fit of one sense-loop capture.

Port of experiments/…/2026-10-06_sense-loop-double/ramp_core2_fit.py ``fit()``: grid-search f0 over
13.50–13.62 MHz (121 points; scope timebase tolerance), LSQ sin/cos/DC, Vrms = amp/√2, residual =
std of the fit error, then a 3-harmonic LSQ at f0 for H2/H3 relative to the fundamental.
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
MIN_FUND_V = 1e-9


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
    """Fit one capture (time in s, volts) and return Vrms, f0, residual, extrema, H2/H3 in %.

    Raises ValueError for too few points, non-finite samples, or no fundamental (e.g. RF off);
    callers treat that as "no valid reading".
    """
    if len(t) < MIN_POINTS or len(t) != len(v):
        raise ValueError(f"need >= {MIN_POINTS} matching points, got {len(t)}/{len(v)}")
    if not (np.isfinite(t).all() and np.isfinite(v).all()):
        raise ValueError("non-finite samples")
    ones = np.ones_like(t)
    best: tuple[float, float, float] | None = None
    for f_try in np.linspace(F_LO_HZ, F_HI_HZ, N_GRID):
        w = 2 * np.pi * f_try * t
        a = np.c_[np.sin(w), np.cos(w), ones]
        c = _lstsq(a, v)
        r = float(np.std(v - a @ c))
        if best is None or r < best[0]:
            best = (r, float(f_try), float(np.hypot(c[0], c[1])))
    assert best is not None
    resid, f0, amp = best
    if amp < MIN_FUND_V:
        raise ValueError("no fundamental (amplitude below MIN_FUND_V)")
    cols = [fn(2 * np.pi * k * f0 * t) for k in (1, 2, 3) for fn in (np.sin, np.cos)]
    c = _lstsq(np.c_[np.array(cols).T, ones], v)
    fund = float(np.hypot(c[0], c[1]))
    if fund < MIN_FUND_V:
        raise ValueError("no fundamental (amplitude below MIN_FUND_V)")
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
