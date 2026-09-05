"""``tcp-serve`` entry point: run the FastAPI app with uvicorn.

Defaults to the simulator on 127.0.0.1:8000. Pass ``--serial <port>`` to drive a real
generator over its serial/USB port (opt-in; see the safety notes in the package docstring).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from tc_power_interface.api.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the T&C Power interface")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)  # 8000 is FLIR's; avoid the collision
    parser.add_argument("--backend", default="simulated", choices=["simulated", "serial"])
    parser.add_argument("--serial", default=None, help="serial port; implies --backend serial")
    parser.add_argument("--poll-interval", type=float, default=0.5)
    parser.add_argument("--experiments-root", default=None, type=Path)
    parser.add_argument(
        "--site-origin",
        default="https://mattlmccoy.github.io",
        help="origin allowed to control this operator cross-origin (the GitHub Pages UI); "
        "pass '' to disable",
    )
    parser.add_argument(
        "--flir-url",
        default=None,
        help="base URL of the FLIR Research Interface to notify on RF on/off (e.g. "
        "http://localhost:8000); omit to disable the link",
    )
    args = parser.parse_args()

    backend = args.backend
    transport_kwargs: dict[str, object] = {}
    if args.serial:
        backend = "serial"
        transport_kwargs["port"] = args.serial

    app = create_app(
        backend=backend,
        poll_interval_s=args.poll_interval,
        experiments_root=args.experiments_root,
        transport_kwargs=transport_kwargs,
        site_origin=args.site_origin or None,
        flir_url=args.flir_url,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
