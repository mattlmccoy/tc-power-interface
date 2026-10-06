"""Load one fetched FLIR run: ROI mean-temperature series (by ROI name) + TC-POWER control stream."""
import json, numpy as np

def load(prefix: str):
    d = json.load(open(f"{prefix}.detail.json")); c = json.load(open(f"{prefix}.control.json")); s = json.load(open(f"{prefix}.series.json"))
    names = {str(r["id"]): r["name"] for r in d["rois"]}
    ts = np.array(s["t_s"])
    ser = {names[k]: np.array([np.nan if x is None else x for x in v["mean"]], float) for k, v in s["series"].items()}
    C = {k: np.array([np.nan if x is None else x for x in c[k]], float) for k in c}
    C["E"] = np.concatenate([[0], np.cumsum(np.nan_to_num(C["forward_w"][1:]) * np.diff(C["t_s"]))]) / 3600
    return ts, ser, C
