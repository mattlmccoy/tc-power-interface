"""Fit parity with ramp_core2_fit.fit() on real 10-06 captures (see fixtures/scope/README.md)."""

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
