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
