"""Capture REAL data into JSON fixtures for the matchmap tests (data-contract rule: never invent).

Run from this folder:  python3 build_fixtures.py
Sources (all under research/binderjet/):
  fullcap_0903.json   experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-09-03_FULLCAP  (settled NanoVNA
                      sweeps, 20 kHz grid with a point exactly at 13.56 MHz; AIT volts -> percent via the
                      TUNE_CAL/LOAD_CAL tables copied from frontend/src/lib/instrument.ts, UNROUNDED)
  tuneonly_0930.json  .../2026-09-30_218-2core_v2/100s_350sh/vna-log-1790803857968.json (live TC-POWER log,
                      v0.11.1, f0OffsetHz=0; only Tune was moved, Load just flickers 23.5/23.6)
  run193906.json      software/TC-POWER/backend/experiments/20260928_193906_RF_20260928_193906/telemetry.csv
                      (100 W run, reflected drifts up at fixed caps, then a Tune step clears it)
"""
import csv, glob, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[7]  # .../research/binderjet
MMN = ROOT / "experiments/rf_sintering/MANUAL_MATCHING_NETWORK"
F0 = 13.56e6
TUNE_CAL = [(0,.12),(1,.18),(2,.22),(3,.27),(4,.32),(5,.36),(6,.41),(7,.46),(8,.51),(9,.55),(10,.6),(15,.84),(20,1.07),(25,1.32),(30,1.55),(35,1.79),(40,2.03),(45,2.26),(50,2.5),(55,2.77),(60,2.98),(65,3.22),(70,3.45),(75,3.69),(80,3.93),(85,4.17),(90,4.41),(95,4.65),(96,4.69),(97,4.74),(98,4.79),(99,4.84),(100,4.89)]
LOAD_CAL = [(0,.14),(1,.18),(2,.23),(3,.27),(4,.32),(5,.37),(6,.42),(7,.46),(8,.51),(9,.56),(10,.6),(15,.86),(20,1.08),(25,1.32),(30,1.56),(35,1.8),(40,2.04),(45,2.28),(50,2.51),(55,2.77),(60,2.99),(65,3.23),(70,3.47),(75,3.71),(80,3.95),(85,4.19),(90,4.43),(95,4.67),(96,4.72),(97,4.77),(98,4.81),(99,4.86),(100,4.91)]

def pct(v, cal):
    for (x0, y0), (x1, y1) in zip(cal, cal[1:]):
        if v <= y1:
            return round(x0 + (v - y0) / (y1 - y0) * (x1 - x0), 3)
    return 100.0

def gamma_at_f0(path):
    best = None
    for line in open(path, errors="ignore"):
        t = line.strip()
        if not t or t[0] in "!#":
            continue
        f, a, b = (float(x) for x in t.split()[:3])
        if best is None or abs(f - F0) < abs(best[0] - F0):
            best = (f, a, b)
    assert abs(best[0] - F0) < 1, path  # a measured point AT 13.56 MHz, not a neighbour
    return {"re": best[1], "im": best[2]}

pts = []
for p in sorted((MMN / "2026-09-03_FULLCAP").iterdir()):
    m = re.match(r"(REP\d|IND-SENS-FULL|IND-SENS|COOR)_.*T(\d\.\d\d)_L(\d\.\d\d)_.*nanovna-sweep-\d+$", p.name)
    if not m:
        continue
    pts.append({"set": m[1], "tuneV": float(m[2]), "loadV": float(m[3]),
                "tune": pct(float(m[2]), TUNE_CAL), "load": pct(float(m[3]), LOAD_CAL), "g": gamma_at_f0(p)})
json.dump({"source": "2026-09-03_FULLCAP (REP/IND-SENS/COOR sets)", "points": pts},
          open("fullcap_0903.json", "w"), indent=1)

log = json.load(open(MMN / "2026-09-30_218-2core_v2/100s_350sh/vna-log-1790803857968.json"))
ents = [{"tune": e["tune"], "load": e["load"], "R": e["R"], "X": e["X"]} for e in log["entries"]]
json.dump({"source": "vna-log-1790803857968.json (" + log["build"] + ")", "entries": ents},
          open("tuneonly_0930.json", "w"), indent=0)

run = sorted(glob.glob(str(ROOT / "software/TC-POWER/backend/experiments/20260928_193906*")))[0]
rows = list(csv.DictReader(open(Path(run) / "telemetry.csv")))
t0 = int(rows[0]["host_timestamp_ns"])
samples = [{"tMs": round((int(r["host_timestamp_ns"]) - t0) / 1e6), "rfOn": r["rf_on"] == "True",
            "fwd": float(r["forward_w"]), "rev": float(r["reverse_w"]),
            "tune": float(r["tune_cap_percent"]), "load": float(r["load_cap_percent"])} for r in rows]
json.dump({"source": Path(run).name + "/telemetry.csv", "samples": samples}, open("run193906.json", "w"), indent=0)
print(len(pts), "fullcap points;", len(ents), "vna entries;", len(samples), "telemetry samples")
for p in pts: print(p["set"], p["tune"], p["load"])
