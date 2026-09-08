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


# Captured from the LIVE FLIR endpoint (0.4.17, http://127.0.0.1:8000) on 2026-09-08 — reality, not
# spec-invented. The healthy frame is FLIR's captured simulated-camera sample (identical shape to a
# real A70); the not-acquiring frame is what the live GET actually returned with no camera/ROIs.
_LIVE_NOT_ACQUIRING = {
    "live": False, "frame_id": None, "frame_ts": None, "age_ms": None, "stale": True, "rois": [],
}
_LIVE_HEALTHY = {
    "live": True, "frame_id": 15, "frame_ts": "2026-09-08T04:37:44.653241+00:00",
    "age_ms": 51.3, "stale": False,
    "rois": [
        {"id": 10, "name": "circle_medium_small", "kind": "circle", "mean_c": 25.73,
         "max_c": 25.73, "min_c": 25.73, "value_c": None, "over_range": False, "valid": True},
        {"id": 45, "name": "trans_hotspot", "kind": "spot", "mean_c": 25.0, "max_c": 25.0,
         "min_c": 25.0, "value_c": 25.0, "over_range": False, "valid": True},
    ],
}


def test_conforms_to_captured_live_payloads():
    # Not acquiring (rois empty roster) -> fail safe, holds 0 W.
    sample, max_c = select_control_temp(_LIVE_NOT_ACQUIRING, ROI)
    assert sample.valid is False and max_c is None
    # Healthy live frame -> selects circle_medium_small.mean_c and exposes its max_c.
    sample, max_c = select_control_temp(_LIVE_HEALTHY, ROI)
    assert sample.valid is True and sample.celsius == 25.73 and max_c == 25.73
    # age_ms is a FLOAT on the wire (51.3); the staleness comparison still trips correctly.
    stale = select_control_temp({**_LIVE_HEALTHY, "age_ms": 1500.7}, ROI, max_age_ms=1000)
    assert stale[0].valid is False


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
