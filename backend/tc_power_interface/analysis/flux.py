"""Sense-loop volts -> core peak flux density, and the warn-only hard-limit flags.

B_pk = √2·Vrms / (N·n_cores·A_e·2πf) = Vrms / (π√2·f·N·n_cores·A_e).
Peak, cross-section average; the toroid inner edge runs ~1.3x higher.
~±5 % uncertainty (lead resonant rise, air term). Source: transformer
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
