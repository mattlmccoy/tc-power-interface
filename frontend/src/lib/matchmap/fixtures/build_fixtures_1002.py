"""Capture REAL data for the 2026-10-02 drift work (data-contract rule: never invent).

Run from this folder:  python3 build_fixtures_1002.py
  fullsweep_1002.json  FULL_SWEEP_20261002_125227 telemetry (ladder 5->70 W, Tune drifted 19.8 -> ~13 %)
  rematch_1002.json    the match map active during that run (2026-10-02 rematch, T1.06/L0.62 V)
  map_v1_0930.json / map_v3_0930.json  first real captures on 218-2core_v2 (for model selection)
"""
import csv, json, shutil
from pathlib import Path
MMN = Path(__file__).resolve().parents[7] / "experiments/rf_sintering/MANUAL_MATCHING_NETWORK"
D = MMN / "2026-10-01_218-2core-mat67_100ser-330sh/2026-10-02"
rows = list(csv.DictReader(open(D / "FULL_SWEEP_20261002_125227_RF_20261002_125227_telemetry.csv")))
t0 = int(rows[0]["host_timestamp_ns"])
json.dump({"source": "FULL_SWEEP_20261002_125227_RF_20261002_125227_telemetry.csv", "samples": [
    {"tMs": round((int(r["host_timestamp_ns"]) - t0) / 1e6), "rfOn": r["rf_on"] == "True", "fwd": float(r["forward_w"]),
     "rev": float(r["reverse_w"]), "tune": float(r["tune_cap_percent"]), "load": float(r["load_cap_percent"])} for r in rows]},
    open("fullsweep_1002.json", "w"))
shutil.copy(D / "2026-10-02_rematch_AIT_T106_L062_match-map-1790955328306.json", "rematch_1002.json")
V = MMN / "2026-09-30_218-2core_v2/100s_330shunt"
shutil.copy(V / "match-map-1790870354045.json", "map_v1_0930.json")
shutil.copy(V / "goodmatchv3_218-2core-mat67-100ser-330sh_v3_match-map-1790871510963.json", "map_v3_0930.json")
print(len(rows), "telemetry rows")

# hvprobe_1001.json: copied verbatim from experiments/.../2026-10-01_218-2core-mat67_100ser-330sh/2180-2core-mat67_HVprobe_AIT_T112_L067_match-map-1790886234100.json (the day BEFORE the 10-02 rematch; used to test re-anchoring)
