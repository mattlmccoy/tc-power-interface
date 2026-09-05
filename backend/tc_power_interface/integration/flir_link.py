"""Best-effort client that POSTs RF on/off events to the FLIR operator.

Fire-and-forget on a background thread with a short timeout; never raises to the caller and never
blocks the RF control loop. `_post` is injectable so the send is unit-tested without HTTP.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import httpx


def build_payload(*, state: str, forward_w: float, reflected_fraction: float,
                  reason: str) -> dict[str, Any]:
    return {"state": state, "forward_w": forward_w,
            "reflected_fraction": reflected_fraction, "reason": reason}


def _http_post(url: str, body: dict[str, Any], timeout: float) -> None:
    httpx.post(url, json=body, timeout=timeout).raise_for_status()


class FlirLink:
    def __init__(self, url: str, *, enabled: bool, timeout: float = 1.0,
                 _post: Callable[[str, dict[str, Any], float], None] = _http_post) -> None:
        self.url = url.rstrip("/")
        self.enabled = enabled
        self.timeout = timeout
        self._post = _post
        self._threads: list[threading.Thread] = []
        self.last_result: dict[str, Any] = {"ok": None, "message": "", "ts": 0.0}

    def notify(self, *, state: str, forward_w: float, reflected_fraction: float,
               reason: str) -> None:
        if not self.enabled or not self.url:
            return
        # Drop finished sends so a long session of RF toggling doesn't accumulate dead threads.
        # (self.url/self.enabled are re-read on the worker thread; if the operator changes them
        # mid-send a request may use the prior value — acceptable for a best-effort link.)
        self._threads = [t for t in self._threads if t.is_alive()]
        body = build_payload(state=state, forward_w=forward_w,
                             reflected_fraction=reflected_fraction, reason=reason)
        t = threading.Thread(target=self._send, args=(body,), daemon=True)
        self._threads.append(t)
        t.start()

    def _send(self, body: dict[str, Any]) -> None:
        try:
            self._post(f"{self.url}/api/rf-link/event", body, self.timeout)
            self.last_result = {"ok": True, "message": "", "ts": time.time()}
        except Exception as exc:  # noqa: BLE001 - best-effort; never propagate
            self.last_result = {"ok": False, "message": str(exc), "ts": time.time()}

    def join(self, timeout: float = 2.0) -> None:
        for t in list(self._threads):
            t.join(timeout)
