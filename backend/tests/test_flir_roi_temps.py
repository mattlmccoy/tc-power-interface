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


# Exact bytes FLIR emits when the control ROI saturates (over-range) while the frame is otherwise
# live: mean_c AND max_c both null, over_range:true, valid:false; other ROIs stay valid. Captured
# 2026-09-08. Saturation = too hot -> must hold 0 W (and max_c is unusable, so the over-temp guard
# trips on valid:false/over_range, never on a max_c number).
_LIVE_SATURATED_CONTROL = {
    "live": True, "frame_id": 42, "frame_ts": "2026-09-08T04:37:44.653241+00:00",
    "age_ms": 0.1, "stale": False,
    "rois": [
        {"id": 10, "name": "circle_medium_small", "kind": "circle", "mean_c": None,
         "max_c": None, "min_c": None, "value_c": None, "over_range": True, "valid": False},
        {"id": 45, "name": "trans_hotspot", "kind": "spot", "mean_c": 185.0, "max_c": 185.0,
         "min_c": 185.0, "value_c": 185.0, "over_range": False, "valid": True},
    ],
}
# No camera, but the ROI IS drawn in the FLIR UI -> roster present, every roi valid:false + null.
_LIVE_NO_CAMERA_ROSTER = {
    "live": False, "frame_id": None, "frame_ts": None, "age_ms": None, "stale": True,
    "rois": [
        {"id": 10, "name": "circle_medium_small", "kind": "circle", "mean_c": None,
         "max_c": None, "min_c": None, "value_c": None, "over_range": False, "valid": False},
    ],
}


# REAL HARDWARE — FLIR A70 (serial 89903739, fw 42.0.0) acquiring, captured 2026-09-08 19:54 UTC.
# Same shape/keys/types as the simulated camera; only the values changed. 8 area ROIs (no spots, so
# value_c is null everywhere). ROI ids CHURNED between runs (front/back_electrode 36/37 -> 50/51),
# which is why the control ROI is keyed by NAME, never id.
_LIVE_A70_HEALTHY = {
    "live": True, "frame_id": 4566, "frame_ts": "2026-09-08T19:54:04.481336+00:00",
    "age_ms": 61.9, "stale": False,
    "rois": [
        {"id": 7, "name": "circle_large_powder", "kind": "circle", "mean_c": 18.9487,
         "max_c": 19.23, "min_c": 18.69, "value_c": None, "over_range": False, "valid": True},
        {"id": 9, "name": "circle_medium_powder", "kind": "circle", "mean_c": 18.9411,
         "max_c": 19.23, "min_c": 18.69, "value_c": None, "over_range": False, "valid": True},
        {"id": 10, "name": "circle_medium_small", "kind": "circle", "mean_c": 18.9334,
         "max_c": 19.16, "min_c": 18.76, "value_c": None, "over_range": False, "valid": True},
        {"id": 33, "name": "shunt_cap_FP", "kind": "polygon", "mean_c": 18.9928,
         "max_c": 19.39, "min_c": 18.34, "value_c": None, "over_range": False, "valid": True},
        {"id": 34, "name": "series_cap_FP", "kind": "polygon", "mean_c": 18.9855,
         "max_c": 19.58, "min_c": 18.32, "value_c": None, "over_range": False, "valid": True},
        {"id": 35, "name": "transformer", "kind": "polygon", "mean_c": 18.6966,
         "max_c": 18.97, "min_c": 18.18, "value_c": None, "over_range": False, "valid": True},
        {"id": 50, "name": "front_electrode", "kind": "polygon", "mean_c": 18.8491,
         "max_c": 19.18, "min_c": 18.37, "value_c": None, "over_range": False, "valid": True},
        {"id": 51, "name": "back_electrode", "kind": "polygon", "mean_c": 18.8459,
         "max_c": 19.37, "min_c": 18.2, "value_c": None, "over_range": False, "valid": True},
    ],
}


def test_conforms_to_the_real_a70_live_payload():
    # Selects the control ROI's mean_c and exposes its max_c from the real camera frame.
    sample, max_c = select_control_temp(_LIVE_A70_HEALTHY, ROI)
    assert sample.valid is True and sample.celsius == 18.9334 and max_c == 19.16
    # The poller surfaces the full 8-ROI roster (in feed order) for the operator's dropdown ...
    src = FlirPollingSource("http://x", roi_name=ROI, _get=_FakeGet([_LIVE_A70_HEALTHY]))
    src.poll_once()
    assert src.available_rois() == [
        "circle_large_powder", "circle_medium_powder", "circle_medium_small", "shunt_cap_FP",
        "series_cap_FP", "transformer", "front_electrode", "back_electrode",
    ]
    # ... and selection is by NAME, so a churned id (front_electrode is now 50) still resolves.
    src.set_roi("front_electrode")
    src.poll_once()
    assert src.read().celsius == 18.8491


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
    # Saturated control ROI while the frame is otherwise live -> hold 0 W, max_c unusable (null).
    sample, max_c = select_control_temp(_LIVE_SATURATED_CONTROL, ROI)
    assert sample.valid is False and max_c is None
    # No camera but the ROI is drawn (present-but-invalid roster) -> hold 0 W.
    assert select_control_temp(_LIVE_NO_CAMERA_ROSTER, ROI)[0].valid is False


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


def test_poller_exposes_the_live_roster_and_switches_control_roi_at_runtime():
    # The operator picks which live ROI to control on (ROIs change print-to-print), so the poller
    # surfaces the whole roster and lets the control ROI be swapped without rebuilding the source.
    src = FlirPollingSource("http://x", roi_name=ROI, _get=_FakeGet([_payload()]))
    src.poll_once()
    assert src.available_rois() == [
        "circle_large_powder", "circle_medium_small", "circle_small_powder",
    ]
    assert src.read().celsius == 182.5  # circle_medium_small.mean_c
    src.set_roi("circle_large_powder")  # switch the control ROI at runtime
    src.poll_once()
    assert src.roi_name == "circle_large_powder"
    assert src.read().celsius == 150.0  # now controls on the newly-selected ROI's mean_c
