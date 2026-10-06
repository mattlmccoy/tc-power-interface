"""Read-only pull of FLIR runs that carry the TC-POWER control stream (detail, control, ROI series).

The FLIR tool (http://localhost:8000) serves runs from the FLIR SSD (/Volumes/FLIR SSD/FLIR-recordings);
plug it in first. Usage:  uv run python tools/flir/fetch_runs.py OUT_DIR [RUN_NAME ...]   (no names = all)
"""
import json, os, sys, urllib.parse, urllib.request

API = "http://localhost:8000/api/experiments"
get = lambda url, t=300: json.load(urllib.request.urlopen(url, timeout=t))

def fetch(out: str, name: str) -> str:
    q = urllib.parse.quote(name)
    if os.path.exists(f"{out}/{name}.series.json"):
        return "cached"
    ctl = get(f"{API}/{q}/control", 120)
    if not isinstance(ctl, dict) or not ctl.get("t_s"):
        return "no control stream"
    det = get(f"{API}/{q}", 120)
    rois = det.get("rois") or []
    if not rois:
        return "no ROIs"
    ser = get(f"{API}/{q}/series?rois={urllib.parse.quote(json.dumps(rois))}&max_points=1500", 600)
    for kind, obj in (("detail", det), ("control", ctl), ("series", ser)):
        json.dump(obj, open(f"{out}/{name}.{kind}.json", "w"))
    return f"ok ({len(ctl['t_s'])} control rows, {len(ser['t_s'])} series points)"

if __name__ == "__main__":
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    names = sys.argv[2:] or [e["name"] for e in get(API)]
    for n in names:
        print(n, fetch(out, n), flush=True)
