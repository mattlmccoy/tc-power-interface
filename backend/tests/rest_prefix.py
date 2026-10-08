"""A SYNTHETIC minute at rest before RF on, for tests that replay recordings starting at RF on.

The cockpit only learns once it has seen the part at rest before RF on (control/ambient.py), and
the recordings used as fixtures begin at RF on. Tests about OTHER behaviour assume a cold start
by prefixing this minute; the warm-start cases are in test_cockpit_ambient.py.
"""

from tc_power_interface.control.run_mode import RunMode


def rest_before_rf_on(obs, temp_c, *, t_on=0.0, seconds=70, part_roi="freehand_sample"):
    """``seconds`` of RF-off readings at ``temp_c`` (1 s apart) ending just before ``t_on``, under
    their own run id, so the run under test starts with the real fixture's first row."""
    for k in range(seconds, 0, -1):
        obs.observe(
            t_s=t_on - k,
            telemetry={"forward_w": 0.0, "rf_on": False},
            part_roi=part_roi,  # the rest window only holds readings of the run's control ROI
            part_temp_c=temp_c,
            temp_status="ok",
            roi_temps=[],
            watch=[],
            run_id="before_rf_on",
            run_mode=RunMode(mode="ladder"),
            target_c=185.0,
            ceiling_w=200.0,
        )
