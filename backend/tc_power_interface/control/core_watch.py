"""Watched ROIs (transformer cores first): each one's mean temperature or a reason, plus the rate of
rise over a trailing window of VALID samples that spans AT LEAST 60 s (sparse ticks stretch it; None
until it does). Display and warn only (D3); the RF-off interlock is a separate build (v0.18).
Pure."""

from __future__ import annotations

import math
from collections import deque
from typing import Any

WINDOW_S = 60.0
MAX_WATCH = 4


def _finite_mean(r: dict[str, Any]) -> float | None:
    """The ROI's mean as a finite float, or None (unknown is None, never 0)."""
    if not r.get("valid"):
        return None
    try:
        c = float(r["mean_c"])
    except (KeyError, TypeError, ValueError):
        return None
    return c if math.isfinite(c) else None


class CoreWatch:
    def __init__(self) -> None:
        self._hist: dict[str, deque[tuple[float, float]]] = {}

    def reset(self) -> None:
        self._hist.clear()

    def update(
        self, t_s: float, roi_temps: list[dict[str, Any]], names: list[str]
    ) -> list[dict[str, Any]]:
        by_name = {r["name"]: r for r in roi_temps if isinstance(r.get("name"), str)}
        watched = list(dict.fromkeys(n for n in names if isinstance(n, str) and n))[:MAX_WATCH]
        for gone in set(self._hist) - set(watched):
            del self._hist[gone]
        out: list[dict[str, Any]] = []
        for name in watched:
            r = by_name.get(name)
            hist = self._hist.setdefault(name, deque())
            c = None if r is None else _finite_mean(r)
            if c is None:
                hist.clear()  # the window must be continuous valid data
                out.append(
                    {
                        "name": name,
                        "temp_c": None,
                        "rate_c_per_min": None,
                        "status": "not_in_feed" if r is None else "invalid",
                    }
                )
                continue
            hist.append((t_s, c))
            while len(hist) > 2 and hist[1][0] <= t_s - WINDOW_S:
                hist.popleft()
            t0, c0 = hist[0]
            rate = (c - c0) / (t_s - t0) * 60.0 if t_s - t0 >= WINDOW_S - 1e-9 else None
            out.append({"name": name, "temp_c": c, "rate_c_per_min": rate, "status": "ok"})
        return out
