"""Per-level summary of sense-loop readings and a session mT/sqrt(W) fit.

The fit uses only levels >= 10 W (the power meter is +/-20 % below that).
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

__all__ = ["LevelSummary", "session_mt_per_sqrtw", "summarize_levels"]


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
    """Group valid, level-assigned rows by power level and summarize each group.

    Rows with a missing or non-positive ``level_w`` are ignored (a 0 W level
    would divide by sqrt(0)).
    """
    groups: dict[float, list[Mapping[str, Any]]] = defaultdict(list)
    for r in rows:
        if r.get("valid") and r.get("level_w") is not None and float(r["level_w"]) > 0:
            groups[float(r["level_w"])].append(r)
    out: list[LevelSummary] = []
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


def session_mt_per_sqrtw(
    levels: list[LevelSummary], *, min_level_w: float = 10.0
) -> float | None:
    """LSQ slope of B vs sqrt(P) through the origin over eligible levels.

    Session-local: it drifts with heating, so do not compare across sessions.
    """
    pts: list[tuple[float, float]] = []
    for s in levels:
        if s.level_w >= min_level_w and s.b_median_mt is not None:
            pts.append((math.sqrt(s.level_w), s.b_median_mt))
    if not pts:
        return None
    return sum(x * y for x, y in pts) / sum(x * x for x, _ in pts)
