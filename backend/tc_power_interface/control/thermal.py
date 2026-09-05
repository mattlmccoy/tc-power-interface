"""ADVISORY thermal-trajectory evaluator (seed of the future FLIR closed loop).

Pure recommender only. Given a control-ROI temperature and a target, it advises whether an
operator/higher controller should increase, hold, or reduce accepted power. It intentionally:

- never enables RF and never commands the generator;
- is subordinate to the protection layer (over-temperature / reflected-power trips live in
  ``safety.py`` and always win);
- eases off *before* the target ("hold" inside the approach band) to respect the several-second
  thermal lag documented in the 2026-09-04 run analysis.

Wiring this to real accepted-power commands is deliberately deferred until the protection loop
and local match tracking are validated at true power (see plan/notes.md and the 09-05 handoff).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ThermalTarget:
    """A control-ROI temperature target with an approach band."""

    target_c: float
    approach_band_c: float = 20.0


@dataclass(frozen=True)
class ThermalRecommendation:
    """An advisory action for the operator / higher controller."""

    action: str  # "increase" | "hold" | "reduce"
    reason: str


def recommend(current_c: float, target: ThermalTarget) -> ThermalRecommendation:
    """Advise increase/hold/reduce for the control ROI (advisory only, never commands RF)."""
    if current_c >= target.target_c:
        return ThermalRecommendation(
            action="reduce",
            reason=f"control ROI {current_c:.1f}C at/above target {target.target_c:.1f}C",
        )
    if current_c >= target.target_c - target.approach_band_c:
        return ThermalRecommendation(
            action="hold",
            reason=(
                f"control ROI {current_c:.1f}C within {target.approach_band_c:.0f}C approach band; "
                "hold to coast up via thermal lag"
            ),
        )
    return ThermalRecommendation(
        action="increase",
        reason=f"control ROI {current_c:.1f}C well below target {target.target_c:.1f}C",
    )
