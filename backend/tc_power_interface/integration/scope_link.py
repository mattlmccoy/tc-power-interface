"""Read-only SDS1202X-E link: open a VISA resource (USB0::… or TCPIP0::…), pull one waveform
per cycle, fit it, and hand a Reading to a callback. Never writes scope settings; never
touches RF control.
Errors are reported in status() and retried with backoff; they never reach the caller."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol, cast

import numpy as np
from numpy.typing import NDArray

from tc_power_interface.analysis.sense_loop_fit import FitResult, fit_sense_loop
from tc_power_interface.integration.scope_codec import (
    codes_to_volts,
    is_clipped,
    parse_number,
    parse_wf_block,
    time_axis,
)
from tc_power_interface.integration.scope_settings import ScopeSettings

logger = logging.getLogger(__name__)


class ScopeResource(Protocol):
    def write(self, cmd: str) -> Any: ...
    def query(self, cmd: str) -> str: ...
    def read_raw(self) -> bytes: ...
    def close(self) -> None: ...


Opener = Callable[[str], ScopeResource]


def open_visa(resource: str) -> ScopeResource:
    import pyvisa  # local import: optional at test time

    rm = pyvisa.ResourceManager("@py")
    res = cast(Any, rm.open_resource(resource))
    res.timeout = 5000
    res.chunk_size = 4 * 1024 * 1024
    return cast(ScopeResource, res)


def list_visa_resources() -> list[str]:
    import pyvisa

    return list(pyvisa.ResourceManager("@py").list_resources())


@dataclass(frozen=True)
class Capture:
    codes: NDArray[np.int8]
    volts: NDArray[np.float64]
    t: NDArray[np.float64]
    attn: float
    vdiv: float
    ofst: float
    tdiv: float
    sara: float
    clipped: bool


@dataclass(frozen=True)
class Reading:
    host_timestamp_ns: int
    capture: Capture
    fit: FitResult | None


def acquire_once(res: ScopeResource, *, channel: int) -> Capture:
    ch = f"C{channel}"
    attn = parse_number(res.query(f"{ch}:ATTN?"))
    vdiv = parse_number(res.query(f"{ch}:VDIV?"))
    ofst = parse_number(res.query(f"{ch}:OFST?"))
    tdiv = parse_number(res.query("TDIV?"))
    sara = parse_number(res.query("SARA?"))
    res.write(f"{ch}:WF? DAT2")
    codes = parse_wf_block(res.read_raw())
    return Capture(
        codes=codes, volts=codes_to_volts(codes, vdiv=vdiv, ofst=ofst),
        t=time_axis(len(codes), tdiv=tdiv, sara=sara),
        attn=attn, vdiv=vdiv, ofst=ofst, tdiv=tdiv, sara=sara, clipped=is_clipped(codes),
    )


class ScopeLink:
    def __init__(
        self,
        *,
        opener: Opener = open_visa,
        on_reading: Callable[[Reading], None],
        backoff_s: float = 2.0,
        join_timeout_s: float = 5.0,
    ) -> None:
        self._opener = opener
        self._on_reading = on_reading
        self._backoff_s = backoff_s
        self._join_timeout_s = join_timeout_s
        self._thread: threading.Thread | None = None
        # One stop Event PER poll thread: a thread stuck in a VISA call past stop()'s join must
        # still see its own event set after a restart (a shared, re-cleared Event would revive it).
        self._stop = threading.Event()
        self._lock = threading.Lock()
        # Held across "am I current? -> callback", and by stop() while it sets the event, so once
        # stop() returns no reading from that generation can still reach on_reading.
        self._publish = threading.Lock()
        self._status: dict[str, Any] = {"running": False, "connected": False, "error": None,
                                        "last_ns": None, "rate_hz": None}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._status)

    def _set(self, **kw: Any) -> None:
        with self._lock:
            self._status.update(kw)

    def _set_if_current(self, stop: threading.Event, **kw: Any) -> bool:
        """Update status only for the current generation; a superseded thread publishes nothing."""
        with self._lock:
            if stop is not self._stop or stop.is_set():
                return False
            self._status.update(kw)
            return True

    def start(self, settings: ScopeSettings) -> None:
        self.stop()
        stop = threading.Event()
        with self._lock:
            self._stop = stop
            self._status.update(running=True, error=None)
        self._thread = threading.Thread(
            target=self._run, args=(settings, stop), name="tcp-scope", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        with self._publish, self._lock:
            self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._join_timeout_s)
            if self._thread.is_alive():
                logger.warning("scope poll thread still blocked after stop(); it exits on its own")
            self._thread = None
        self._set(running=False, connected=False)

    def _run(self, s: ScopeSettings, stop: threading.Event) -> None:
        while not stop.is_set():
            res: ScopeResource | None = None
            try:
                res = self._opener(s.resource)
                res.write("CHDR OFF")
                if not self._set_if_current(stop, connected=True, error=None):
                    break
                last = time.monotonic()
                while not stop.is_set():
                    cap = acquire_once(res, channel=s.channel)
                    fit = None
                    if not cap.clipped:
                        try:
                            fit = fit_sense_loop(cap.t, cap.volts)
                        except ValueError:  # RF off / DC / non-finite: invalid reading
                            fit = None
                    now = time.monotonic()
                    rate = round(1.0 / max(now - last, 1e-6), 2)
                    with self._publish:
                        if not self._set_if_current(stop, last_ns=time.time_ns(), rate_hz=rate):
                            break  # superseded while blocked in acquire: drop the reading
                        self._on_reading(Reading(time.time_ns(), cap, fit))
                    last = now
                    stop.wait(s.poll_interval_s)
            except Exception as exc:  # noqa: BLE001 - VISA/USB errors are varied; report and retry
                logger.warning("scope link error: %s", exc)
                self._set_if_current(stop, connected=False, error=f"{type(exc).__name__}: {exc}")
            finally:
                if res is not None:
                    try:
                        res.close()
                    except Exception:  # noqa: BLE001
                        pass
            stop.wait(self._backoff_s)
