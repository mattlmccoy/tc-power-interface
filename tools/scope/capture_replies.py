"""Read-only scope capture: raw SCPI replies + waveforms, paired with operator telemetry.

Sends the scope ONLY `CHDR OFF`, `?` queries and `C1:WF? DAT2`, and HTTP-GETs the operator
status. It never commands RF and never changes a scope setting other than the reply header.
The output directory is suitable as a test fixture (replies.json, wf_N.bin, readings.json).

Usage (from backend/):
    uv run python ../tools/scope/capture_replies.py TCPIP0::192.168.7.50::INSTR out_dir \\
        [--n 10] [--operator-url http://127.0.0.1:8010]
"""

from __future__ import annotations

import argparse
import json
import logging
import time
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger("capture_replies")

QUERIES = ("*IDN?", "C1:ATTN?", "C1:VDIV?", "C1:OFST?", "TDIV?", "SARA?", "TRMD?")
TELEMETRY_KEYS = ("forward_w", "reverse_w", "rf_on", "tune_cap_percent", "load_cap_percent")


def telemetry(operator_url: str | None) -> dict[str, Any]:
    """Operator telemetry via HTTP GET (read-only); empty when no URL is given."""
    if not operator_url:
        return {}
    with urllib.request.urlopen(f"{operator_url.rstrip('/')}/api/status", timeout=2) as r:
        t = json.load(r)["controller"].get("telemetry") or {}
    return {k: t.get(k) for k in TELEMETRY_KEYS}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("resource", help="VISA resource string, e.g. TCPIP0::192.168.7.50::INSTR")
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--n", type=int, default=10, help="number of waveforms (default 10)")
    ap.add_argument("--operator-url", default=None, help="e.g. http://127.0.0.1:8010")
    args = ap.parse_args()

    import pyvisa

    from tc_power_interface.analysis.flux import LoopGeometry, b_pk_mt
    from tc_power_interface.analysis.sense_loop_fit import fit_sense_loop
    from tc_power_interface.integration.scope_codec import (
        codes_to_volts,
        is_clipped,
        parse_number,
        parse_wf_block,
        time_axis,
    )

    logging.basicConfig(level=logging.INFO)
    out: Path = args.out_dir
    out.mkdir(parents=True, exist_ok=True)
    scope = pyvisa.ResourceManager("@py").open_resource(args.resource)
    scope.timeout = 8000
    scope.chunk_size = 4 * 1024 * 1024
    scope.write("CHDR OFF")
    replies = {q: scope.query(q) for q in QUERIES}
    (out / "replies.json").write_text(json.dumps(replies, indent=2))
    vdiv, ofst = parse_number(replies["C1:VDIV?"]), parse_number(replies["C1:OFST?"])
    tdiv, sara = parse_number(replies["TDIV?"]), parse_number(replies["SARA?"])
    rows: list[dict[str, Any]] = []
    for i in range(args.n):
        tel = telemetry(args.operator_url)
        scope.write("C1:WF? DAT2")
        raw = scope.read_raw()
        (out / f"wf_{i}.bin").write_bytes(raw)
        codes = parse_wf_block(raw)
        volts = codes_to_volts(codes, vdiv=vdiv, ofst=ofst)
        row: dict[str, Any] = {**tel, "clipped": is_clipped(codes), "n": len(codes)}
        try:
            fit = fit_sense_loop(time_axis(len(codes), tdiv=tdiv, sara=sara), volts)
            row.update(
                vrms_v=round(fit.vrms_v, 3),
                f0_mhz=round(fit.f0_hz / 1e6, 4),
                resid_v=round(fit.resid_v, 3),
                pkpk_v=round(float(volts.max() - volts.min()), 1),
                h2_pct=round(fit.h2_pct, 3),
                h3_pct=round(fit.h3_pct, 3),
                b_pk_mt=round(b_pk_mt(fit.vrms_v, fit.f0_hz, LoopGeometry()), 3),
            )
        except ValueError as exc:
            row["fit_error"] = str(exc)
        rows.append(row)
        logger.info("%s", row)
        time.sleep(0.25)
    scope.close()
    (out / "readings.json").write_text(json.dumps(rows, indent=2))
    logger.info("wrote %s", out)


if __name__ == "__main__":
    main()
