"""Room temperature for the shadow loop's first-order model, decided once per run at RF on.

The estimator models dT/dt = a·P − b·(T − T_amb), so a wrong T_amb biases K with full confidence.
It used to take the part temperature at RF on as T_amb. Run 20261007_171928 began 8 min after
another run, with the part still cooling (29.1 °C vs a 22.8 °C room). Replayed through v0.18.4, it
learned K 0.30 °C/W (truth ≈0.43-0.51) and showed 0.73 confidence.

Order: a part at REST before RF on (its temperature is the room's), else the operator's room
reference ROI, else unknown. Unknown means the shadow does not learn this run and says why.

Constants (docs/superpowers/plans/2026-10-08-shadow-room-temperature.md):
- REST_SLOPE_C_PER_MIN: the T_amb error is about slope x tau. At 0.3 °C/min and tau 140-280 s
  that is 0.7-1.4 °C, a ≤ ~9 % K error at the 15-25 °C rises seen at 30-55 W. Run 171928
  started at about −1.8 °C/min.
- FLIR part-mean noise is about 0.1 °C rms, so a 60 s slope has a ≈0.035 °C/min standard error.
  The limit is about 9 σ above noise.
Pure: no I/O.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

#: The window before RF on that must show the part at rest.
REST_WINDOW_S = 60.0
#: Readings must cover at least this much of the window ...
REST_MIN_SPAN_S = 50.0
#: ... with the newest no older than this before RF on ...
REST_MAX_AGE_S = 5.0
#: ... and no hole longer than this.
REST_MAX_GAP_S = 10.0
#: |slope| above this (°C/min) = the part is still cooling or warming.
REST_SLOPE_C_PER_MIN = 0.3


@dataclass(frozen=True)
class Ambient:
    """``source``: "part_at_rest" | "reference" | "assumed" | None (unknown). ``reason`` says why
    the part could not be used ("part_cooling" | "part_warming" | "rf_recent" | "rf_unknown" (no
    generator attached to see RF) | "no_history"); it is kept when a reference covers for it."""

    t_amb_c: float | None
    source: str | None
    reason: str | None = None
    slope_c_per_min: float | None = None
    reference_roi: str | None = None


def _fin(x: float | None) -> bool:
    return x is not None and math.isfinite(x)


def _slope_per_min(pts: list[tuple[float, float]]) -> float:
    n = len(pts)
    mt = sum(t for t, _ in pts) / n
    mc = sum(c for _, c in pts) / n
    stt = sum((t - mt) ** 2 for t, _ in pts)
    return 60.0 * sum((t - mt) * (c - mc) for t, c in pts) / stt if stt > 0 else 0.0


def _rest(history: Sequence[tuple[float, float, bool | None]], t_on: float) -> Ambient:
    """The part's own verdict: at rest (with its mean temperature) or why not. A reading's RF flag
    is None when no generator was attached to tell (RF could have been on from the front panel)."""
    window = [(t, c, rf) for t, c, rf in history if t_on - REST_WINDOW_S <= t < t_on]
    if any(rf for _, _, rf in window):
        return Ambient(None, None, "rf_recent")
    if any(rf is None for _, _, rf in window):
        return Ambient(None, None, "rf_unknown")
    pts = [(t, c) for t, c, _ in window if _fin(c)]
    if len(pts) < 2:
        return Ambient(None, None, "no_history")
    times = [t for t, _ in pts]
    gaps = (b - a for a, b in zip(times, times[1:], strict=False))
    if (
        times[-1] - times[0] < REST_MIN_SPAN_S
        or t_on - times[-1] > REST_MAX_AGE_S
        or max(gaps) > REST_MAX_GAP_S
    ):
        return Ambient(None, None, "no_history")
    slope = _slope_per_min(pts)
    if slope < -REST_SLOPE_C_PER_MIN:
        return Ambient(None, None, "part_cooling", slope)
    if slope > REST_SLOPE_C_PER_MIN:
        return Ambient(None, None, "part_warming", slope)
    return Ambient(sum(c for _, c in pts) / len(pts), "part_at_rest", None, slope)


def judge_ambient(
    history: Sequence[tuple[float, float, bool | None]],
    *,
    t_on: float,
    ref_roi: str | None,
    ref_temp_c: float | None,
) -> Ambient:
    """Decide the room temperature at RF on from the part readings ``(t_s, temp_c, rf_on)`` before
    ``t_on`` (later ones are ignored) and the reference ROI's reading at RF on."""
    part = _rest(history, t_on)
    if part.source is not None:
        return part
    if ref_roi and _fin(ref_temp_c):
        return Ambient(ref_temp_c, "reference", part.reason, part.slope_c_per_min, ref_roi)
    return part
