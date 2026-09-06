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
    """Reverse fraction (FLOOR..CEILING) for caps (tune, load) vs the optimum (t_opt, l_opt)."""
    dt = (tune - t_opt) / TUNE_WIDTH
    dl = (load - l_opt) / LOAD_WIDTH
    well = math.exp(-0.5 * (dt * dt + dl * dl))  # 1 at the optimum, → 0 far away
    return FLOOR + (CEILING - FLOOR) * (1.0 - well)
