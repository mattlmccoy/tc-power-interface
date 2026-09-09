"""Polling control-temperature source backed by the FLIR ``GET /api/live/roi-temps`` endpoint.

Satisfies the thermal loop's ``read() -> TemperatureSample`` protocol. It selects one named control
ROI's mean temperature and FAILS SAFE to ``valid=False`` on any staleness/absence/error, so the loop
holds 0 W rather than ramping on a bad reading (the AIT's over-temp guard uses ``latest_max_c``).

The selection/fail-safe logic (:func:`select_control_temp`) is pure; the poller runs a background
thread and its HTTP GET is injectable so it is unit-tested without a live FLIR backend.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from tc_power_interface.control.temperature import TemperatureSample


def _http_get(url: str, timeout: float) -> dict[str, Any]:
    response = httpx.get(url, timeout=timeout)
    response.raise_for_status()
    parsed: dict[str, Any] = response.json()
    return parsed


def select_control_temp(
    payload: dict[str, Any],
    roi_name: str,
    *,
    stat: str = "mean_c",
    max_age_ms: float = 1000.0,
    recv_ts: float = 0.0,
) -> tuple[TemperatureSample, float | None]:
    """Pick the control ROI's ``stat`` from a roi-temps payload, failing safe to ``valid=False``.

    Returns ``(control_sample, max_c)``. The control sample is invalid (so the loop holds 0 W) when
    the frame is not live, flagged stale, older than ``max_age_ms``, or the named ROI is missing /
    invalid (saturated) / has a null stat. ``max_c`` (for the independent over-temp safety input) is
    returned only alongside a trustworthy ROI, else ``None``.
    """
    invalid = TemperatureSample(celsius=0.0, valid=False, ts=recv_ts)
    if not payload.get("live", False) or payload.get("stale", False):
        return invalid, None
    age_ms = payload.get("age_ms")
    if age_ms is None or age_ms > max_age_ms:
        return invalid, None
    roi = next((r for r in payload.get("rois", []) if r.get("name") == roi_name), None)
    if roi is None or not roi.get("valid", False):
        return invalid, None
    value = roi.get(stat)
    if value is None:
        return invalid, None
    max_c = roi.get("max_c")
    return (
        TemperatureSample(celsius=float(value), valid=True, ts=recv_ts),
        float(max_c) if max_c is not None else None,
    )


class FlirPollingSource:
    """Polls ``GET /api/live/roi-temps`` on a background thread; ``read()`` returns the latest
    control-ROI sample (non-blocking). Fails safe to ``valid=False`` on any fetch/parse error."""

    def __init__(
        self,
        url: str,
        *,
        roi_name: str = "circle_medium_small",
        stat: str = "mean_c",
        max_age_ms: float = 1000.0,
        poll_hz: float = 5.0,
        timeout: float = 0.5,
        _get: Callable[[str, float], dict[str, Any]] = _http_get,
    ) -> None:
        self.url = url
        self.roi_name = roi_name
        self.stat = stat
        self.max_age_ms = max_age_ms
        self.timeout = timeout
        self._interval = 1.0 / poll_hz if poll_hz > 0 else 0.2
        self._get = _get
        self._latest = TemperatureSample(celsius=0.0, valid=False, ts=0.0)
        self.latest_max_c: float | None = None
        self._roi_names: list[str] = []
        self._roi_temps: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def set_roi(self, name: str) -> None:
        """Switch the control ROI at runtime (the operator picks from the live roster). The next
        poll reads the newly-selected ROI; a name not present in the feed fails safe (0 W)."""
        self.roi_name = name

    def available_rois(self) -> list[str]:
        """The names in the latest feed's roster (always present, even for invalid/absent ROIs), so
        the UI can offer the operator the current live ROIs to control on."""
        with self._lock:
            return list(self._roi_names)

    def latest_roi_temps(self) -> list[dict[str, Any]]:
        """The last feed's per-ROI ``mean_c`` + ``valid`` (for the hero's optional overlay). Kept
        from the last non-empty poll, so a transient fetch error never blanks it."""
        with self._lock:
            return [dict(r) for r in self._roi_temps]

    def poll_once(self) -> None:
        names: list[str] = []
        roster: list[dict[str, Any]] = []
        try:
            payload = self._get(self.url, self.timeout)
            names = [r.get("name") for r in payload.get("rois", []) if r.get("name")]
            roster = [
                {
                    "name": r.get("name"),
                    "mean_c": r.get("mean_c"),
                    "valid": bool(r.get("valid", False)),
                }
                for r in payload.get("rois", [])
                if r.get("name")
            ]
            sample, max_c = select_control_temp(
                payload, self.roi_name, stat=self.stat,
                max_age_ms=self.max_age_ms, recv_ts=time.time(),
            )
        except Exception:  # noqa: BLE001 - any fetch/parse failure must fail safe to invalid
            sample, max_c = TemperatureSample(celsius=0.0, valid=False, ts=time.time()), None
        with self._lock:
            self._latest = sample
            self.latest_max_c = max_c
            if names:  # keep the last known roster if a poll returns none (e.g. a transient error)
                self._roi_names = names
                self._roi_temps = roster

    def read(self) -> TemperatureSample:
        with self._lock:
            return self._latest

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.poll_once()
            self._stop.wait(self._interval)

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None:
            t.join(timeout=2.0)
