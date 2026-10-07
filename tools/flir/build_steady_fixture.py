"""Build the steady-power test fixture from the REAL TC-POWER recording 20261007_165850 (data-contract
rule 3: fixtures are captured, never invented). One steady ~30.5 W hold for 12.8 min, no power step:
the part kept heating along a slow second heat path, so the first-order estimate drifted (K 0.42 ->
0.53 C/W, tau 176 -> 278 s) while the RLS fit confidence climbed to ~0.92.

Resamples the recording's forward_w (linear), rf_on (zero-order hold: the last row at or before each
grid time) and the freehand_sample ROI mean from roi_temps.csv (linear) onto a 5 s grid from the
first telemetry row, the grid the estimator uses. Output has the same shape as
flir_20261002_125228_estimator.json plus an ``rf_on`` list. The recording is gitignored, so pass its
directory. Usage (repo root):
    python3 tools/flir/build_steady_fixture.py <path/to/20261007_165850_RF_20261007_165850>
"""
import csv
import json
import sys
from pathlib import Path

import numpy as np

RUN = "20261007_165850_RF_20261007_165850"
ROI = "freehand_sample"
OUT = Path("backend/tests/fixtures/run_20261007_165850_steady30w.json")


def main() -> None:
    run = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("backend/experiments") / RUN
    tel = list(csv.DictReader((run / "telemetry.csv").open(newline="")))
    t0 = int(tel[0]["host_timestamp_ns"])
    tt = np.array([(int(r["host_timestamp_ns"]) - t0) / 1e9 for r in tel])
    fwd = np.array([float(r["forward_w"] or 0.0) for r in tel])
    rf = np.array([r["rf_on"] == "True" for r in tel])
    rt, rv = [], []
    for r in csv.DictReader((run / "roi_temps.csv").open(newline="")):
        if r["roi"] == ROI and r["mean_c"]:
            rt.append((int(r["host_timestamp_ns"]) - t0) / 1e9)
            rv.append(float(r["mean_c"]))
    t = np.arange(0, tt[-1] + 1e-9, 5.0)
    idx = np.searchsorted(tt, t, side="right") - 1  # last row at or before each grid time
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": f"TC-POWER recording {RUN} (telemetry.csv + roi_temps.csv {ROI}), resampled to 5 s "
        "(tools/flir/build_steady_fixture.py)",
        "t_s": [float(x) for x in t],
        "forward_w": [round(float(x), 2) for x in np.interp(t, tt, fwd)],
        "rf_on": [bool(rf[i]) for i in idx],
        "rois": {ROI: [round(float(v), 3) for v in np.interp(t, rt, rv)]},
    }))
    temps = np.interp(t, rt, rv)
    print(f"{len(t)} samples, {ROI} {temps[0]:.2f} -> {temps[-1]:.2f} C, rf_on {int(rf[idx].sum())}/{len(t)}")


if __name__ == "__main__":
    main()
