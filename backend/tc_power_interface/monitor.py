"""``tcp-monitor``: live console telemetry via the full controller (lease + protection).

Prints one telemetry line per interval until interrupted. Runs the same Controller the API
uses, so the control lease is refreshed and the protection layer is active, but it never
enables RF on its own.
"""

from __future__ import annotations

import argparse
import time

from tc_power_interface.control.controller import Controller
from tc_power_interface.device import create_transport
from tc_power_interface.device.cxn import CxnDevice


def main() -> None:
    parser = argparse.ArgumentParser(description="Live CXN telemetry monitor (RF stays off)")
    parser.add_argument("--serial", default=None, help="serial port; omit for the simulator")
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()

    transport = create_transport("serial", port=args.serial) if args.serial else create_transport(
        "simulated"
    )
    controller = Controller(CxnDevice(transport), poll_interval_s=min(args.interval, 0.5))
    controller.start()
    try:
        while True:
            snap = controller.snapshot()
            t = snap["telemetry"]
            if t is None:
                print(f"[{snap['state']}] waiting for telemetry...")
            else:
                print(
                    f"[{snap['state']}] fwd={t['forward_w']:.1f}W rev={t['reverse_w']:.1f}W "
                    f"rho={t['reflected_fraction']:.3f} rf={'ON' if t['rf_on'] else 'off'} "
                    f"T={t['temperature_c']:.1f}C"
                    + (f"  WARN {snap['warnings']}" if snap["warnings"] else "")
                    + (f"  FAULT {snap['fault_reasons']}" if snap["fault_reasons"] else "")
                )
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        controller.stop()


if __name__ == "__main__":
    main()
