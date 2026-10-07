"""Build the estimator test fixture from the cached REAL FLIR run 20261002_125228 (data-contract rule 3:
fixtures are captured, never invented). Resamples TC-POWER forward power and every FLIR ROI mean onto a
5 s grid (np.interp), the same grid the estimator uses. Usage (repo root):
    python3 tools/flir/build_estimator_fixture.py
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from runview import load  # noqa: E402

RUN = "20261002_125228_Run"
OUT = Path("backend/tests/fixtures/flir_20261002_125228_estimator.json")


def main() -> None:
    ts, ser, C = load(f"tools/flir/.cache/{RUN}")
    t = np.arange(0, C["t_s"][-1] + 1e-9, 5.0)
    fwd = np.interp(t, C["t_s"], np.nan_to_num(C["forward_w"]))
    rois = {name: [round(float(v), 3) for v in np.interp(t, ts, s)] for name, s in ser.items()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": f"FLIR {RUN} + TC-POWER control stream, resampled to 5 s (tools/flir/build_estimator_fixture.py)",
        "t_s": [float(x) for x in t],
        "forward_w": [round(float(x), 2) for x in fwd],
        "rois": rois,
    }))
    print(f"{len(t)} samples, {len(rois)} ROIs, part freehand_sample {rois['freehand_sample'][0]} -> {rois['freehand_sample'][-1]} C")


if __name__ == "__main__":
    main()
