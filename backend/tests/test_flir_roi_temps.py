"""Tests for the polling FLIR /api/live/roi-temps control-temperature source.

Fixtures are SPEC-DERIVED from the locked FLIR<->TC-POWER contract (2026-09-08), not yet captured
from the live endpoint — the byte-for-byte conform + end-to-end run happen against FLIR's real
sample once its GET is up. Pure selection/fail-safe logic and the injected-IO poller are unit-tested
here without HTTP.
"""

from tc_power_interface.integration.flir_roi_temps import (
    FlirPollingSource,
    select_control_temp,
)

ROI = "circle_medium_small"


def _payload(*, live=True, stale=False, age_ms=200,
             mean_c=182.5, max_c=190.1, valid=True):
    """A roi-temps payload with the control ROI plus two virgin-bed _powder circles to ignore."""
    return {
        "live": live,
        "frame_id": 4211,
        "frame_ts": "2026-09-08T12:00:00.200Z",
        "age_ms": age_ms,
        "stale": stale,
        "rois": [
            {"id": 1, "name": "circle_large_powder", "kind": "circle",
             "mean_c": 150.0, "max_c": 160.0, "min_c": 140.0, "value_c": None,
             "over_range": False, "valid": True},
            {"id": 2, "name": ROI, "kind": "circle",
             "mean_c": mean_c, "max_c": max_c, "min_c": 175.0, "value_c": None,
             "over_range": not valid, "valid": valid},
            {"id": 3, "name": "circle_small_powder", "kind": "circle",
             "mean_c": 148.0, "max_c": 158.0, "min_c": 138.0, "value_c": None,
             "over_range": False, "valid": True},
        ],
    }


def test_healthy_frame_selects_the_named_roi_mean_and_returns_max():
    sample, max_c = select_control_temp(_payload(), ROI, recv_ts=99.0)
    assert sample.valid is True
    assert sample.celsius == 182.5  # the control ROI's mean_c, not a _powder circle
    assert sample.ts == 99.0
    assert max_c == 190.1  # exposed for the independent over-temp safety input


def test_stale_flag_forces_invalid():
    sample, max_c = select_control_temp(_payload(stale=True), ROI)
    assert sample.valid is False
    assert max_c is None


def test_age_over_threshold_forces_invalid():
    sample, _ = select_control_temp(_payload(age_ms=1500), ROI, max_age_ms=1000)
    assert sample.valid is False


def test_not_live_forces_invalid():
    sample, _ = select_control_temp(_payload(live=False), ROI)
    assert sample.valid is False


def test_missing_control_roi_forces_invalid():
    sample, max_c = select_control_temp(_payload(), "no_such_roi")
    assert sample.valid is False
    assert max_c is None


def test_saturated_control_roi_forces_invalid_even_when_frame_is_live():
    # over_range/saturated ROI -> valid:false + null temps for that ROI (rest of frame is fine)
    sample, max_c = select_control_temp(_payload(valid=False, mean_c=None, max_c=None), ROI)
    assert sample.valid is False
    assert max_c is None


class _FakeGet:
    """Injectable GET returning queued payloads (or raising) so the poller runs without HTTP."""

    def __init__(self, results):
        self._results = list(results)
        self.calls = 0

    def __call__(self, url, timeout):
        self.calls += 1
        r = self._results[min(self.calls - 1, len(self._results) - 1)]
        if isinstance(r, Exception):
            raise r
        return r


def test_poller_updates_latest_from_a_healthy_poll():
    src = FlirPollingSource("http://x/api/live/roi-temps", roi_name=ROI,
                            _get=_FakeGet([_payload()]))
    src.poll_once()
    s = src.read()
    assert s.valid is True and s.celsius == 182.5
    assert src.latest_max_c == 190.1


def test_poller_fails_safe_to_invalid_on_get_error():
    src = FlirPollingSource("http://x/api/live/roi-temps", roi_name=ROI,
                            _get=_FakeGet([RuntimeError("connection refused")]))
    src.poll_once()
    assert src.read().valid is False  # never a stale/fake reading on a failed fetch
