"""``tcp-probe``: read-only commissioning probe (never enables RF).

This is the first tool to run against a real generator (the step the RF handoffs prescribe):
establish communications, read identity, and poll a few telemetry samples with RF OFF, then
compare the printed values against the front panel to confirm the unit speaks the CXN dialect.

It deliberately does NOT request control or enable RF, so it cannot change the generator state.
Defaults to the simulator when no ``--serial`` port is given.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from tc_power_interface.device import create_transport
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.protocol.codec import Status


def _telemetry_dict(device: CxnDevice) -> dict[str, Any]:
    t = device.read_telemetry()
    d = asdict(t)
    d["status"] = int(t.status)
    d["status_flags"] = [f.name for f in Status if f in t.status]
    return d


def run_probe(*, serial_port: str | None, samples: int, interval: float) -> dict[str, Any]:
    transport = create_transport("serial", port=serial_port) if serial_port else create_transport(
        "simulated"
    )
    device = CxnDevice(transport)
    try:
        report: dict[str, Any] = {
            "backend": "serial" if serial_port else "simulated",
            "port": serial_port,
            "identify": device.identify(),
            "samples": [],
        }
        for _ in range(samples):
            report["samples"].append(_telemetry_dict(device))
            time.sleep(interval)
        return report
    finally:
        device.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only CXN probe (RF stays off)")
    parser.add_argument("--serial", default=None, help="serial port; omit for the simulator")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--output", type=Path, default=None, help="write JSON report here")
    args = parser.parse_args()

    report = run_probe(serial_port=args.serial, samples=args.samples, interval=args.interval)
    text = json.dumps(report, indent=2)
    print(text)
    if args.output:
        args.output.write_text(text)
        print(f"\nwrote {args.output}")


if __name__ == "__main__":
    main()
