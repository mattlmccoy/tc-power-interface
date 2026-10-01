"""Capture REAL sweep pairs for the stale-read guard (data-contract rule: never invent).

Run from this folder:  python3 build_freshness.py
  stale: two consecutive map sweeps at the same caps, v0.12.0 fast reads (~210 ms) — identical except point 0
         experiments/.../2026-09-30_218-2core_v2/100s_330shunt/vna-log-1790870360884.json
  fresh: two consecutive auto sweeps at the same caps, v0.7.8 slow reads (~850 ms) — noise differs everywhere
         experiments/.../2026-09-09_VNA_AUTO_MATCH/attempted_auto_then_manual_at_end_vna-log-1789069503478.json
"""
import json
from pathlib import Path

MMN = Path(__file__).resolve().parents[7] / "experiments/rf_sintering/MANUAL_MATCHING_NETWORK"

def pair(log, phase):
    E = [e for e in json.load(open(MMN / log))["entries"] if e.get("sweep") and e["phase"] == phase]
    for a, b in zip(E, E[1:]):
        if a["tune"] == b["tune"] and a["load"] == b["load"]:
            return {"tune": a["tune"], "load": a["load"], "readMs": [a.get("readMs"), b.get("readMs")], "a": a["sweep"], "b": b["sweep"]}
    raise SystemExit(f"no same-caps pair in {log}")

out = {
    "stale": pair("2026-09-30_218-2core_v2/100s_330shunt/vna-log-1790870360884.json", "map"),
    "fresh": pair("2026-09-09_VNA_AUTO_MATCH/attempted_auto_then_manual_at_end_vna-log-1789069503478.json", "auto"),
}
json.dump(out, open("freshness_pairs.json", "w"))
for k, v in out.items():
    diff = sum(1 for x, y in zip(v["a"], v["b"]) if x != y)
    print(k, "caps", v["tune"], v["load"], "readMs", v["readMs"], "points", len(v["a"]), "differing", diff)
