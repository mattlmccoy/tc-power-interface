"""FastAPI application factory for the T&C Power interface.

Mirrors the FLIR backend: a ``create_app(...)`` factory with a ``lifespan`` that owns the
controller (which owns the device + telemetry thread) and a telemetry recorder, exposing a
small REST surface plus a single ``/ws/telemetry`` WebSocket. Serves the built frontend at
``/`` if present.

Safety: the only RF-enable path is ``POST /api/rf/enable`` -> ``controller.enable_rf()``, which
the protection layer refuses while faulted. The default backend is the simulator.
"""

from __future__ import annotations

import asyncio
import contextlib
import platform
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from tc_power_interface import __version__
from tc_power_interface.control.controller import Controller
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.device import create_transport
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.recording.recorder import RecorderState, TelemetryRecorder

API_VERSION = "0.1"
_DEFAULT_FRONTEND_DIST = Path(__file__).resolve().parents[2].parent / "frontend" / "dist"

# Cross-origin protection (mirrors FLIR): the site-mode UI talks to the LOCAL operator, so a
# state-changing request from any other origin must carry X-TCP-Client. The operator-served UI
# (same origin) and local tools without an Origin header are unaffected.
LOCAL_ORIGIN_RE = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
CLIENT_HEADER = "x-tcp-client"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def install_cross_origin_policy(app: FastAPI, *, site_origin: str | None) -> None:
    """CORS for localhost + the site origin; X-TCP-Client required on cross-origin writes."""
    from starlette.middleware.cors import CORSMiddleware
    from starlette.requests import Request as StarletteRequest
    from starlette.responses import JSONResponse

    def _cross_origin(request: StarletteRequest) -> bool:
        origin = request.headers.get("origin")
        if not origin:
            return False
        host = request.headers.get("host", "")
        return origin.split("://", 1)[-1].lower() != host.lower()

    @app.middleware("http")
    async def _client_header_guard(request: StarletteRequest, call_next):  # type: ignore[no-untyped-def]
        if (
            request.method not in SAFE_METHODS
            and request.url.path.startswith("/api/")
            and _cross_origin(request)
            and request.headers.get(CLIENT_HEADER) != "1"
        ):
            return JSONResponse(
                {"detail": "browser requests must send the X-TCP-Client: 1 header"},
                status_code=403,
            )
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[site_origin] if site_origin else [],
        allow_origin_regex=LOCAL_ORIGIN_RE,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["content-type", CLIENT_HEADER],
        allow_private_network=True,  # Chrome Local Network Access preflight
        max_age=600,
    )


class SetpointRequest(BaseModel):
    watts: int


class CapacityRequest(BaseModel):
    percent: int


class ManualModeRequest(BaseModel):
    on: bool


class RecordingStartRequest(BaseModel):
    name: str
    notes: str = ""


def create_app(
    *,
    backend: str = "simulated",
    poll_interval_s: float = 0.5,
    experiments_root: Path | None = None,
    limits: SafetyLimits | None = None,
    transport_kwargs: dict[str, Any] | None = None,
    frontend_dist: Path | None = None,
    site_origin: str | None = None,
) -> FastAPI:
    """Build the FastAPI app. The controller/device start in the lifespan."""
    experiments_root = Path(experiments_root or (Path.cwd() / "experiments"))
    limits = limits or SafetyLimits()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        transport = create_transport(backend, **(transport_kwargs or {}))
        controller = Controller(
            CxnDevice(transport), limits=limits, poll_interval_s=poll_interval_s
        )
        recorder = TelemetryRecorder(experiments_root)
        controller.add_listener(recorder.record)
        controller.start()
        try:
            device_info = controller.identify()
        except Exception:  # noqa: BLE001 - identity is best-effort; keep serving
            device_info = {}

        app.state.controller = controller
        app.state.recorder = recorder
        app.state.device_info = device_info
        app.state.backend = backend
        app.state.current_run = None
        try:
            yield
        finally:
            if recorder.state is RecorderState.RECORDING:
                recorder.stop()
            controller.stop()

    app = FastAPI(title="T&C Power Interface", version=__version__, lifespan=lifespan)
    install_cross_origin_policy(app, site_origin=site_origin)

    def _controller() -> Controller:
        return cast(Controller, app.state.controller)

    def _recorder() -> TelemetryRecorder:
        return cast(TelemetryRecorder, app.state.recorder)

    # --- REST ------------------------------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "version": __version__,
            "api_version": API_VERSION,
            "backend": app.state.backend,
            "platform": platform.platform(),
        }

    def _status_payload() -> dict[str, Any]:
        rec = _recorder()
        return {
            "device": app.state.device_info,
            "controller": _controller().snapshot(),
            "recording": {
                "active": rec.state is RecorderState.RECORDING,
                "run": app.state.current_run,
            },
        }

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return _status_payload()

    @app.post("/api/setpoint")
    def set_setpoint(req: SetpointRequest) -> dict[str, Any]:
        applied = _controller().set_setpoint(req.watts)
        return {"requested_w": req.watts, "applied_w": applied}

    @app.post("/api/rf/enable")
    def rf_enable() -> dict[str, Any]:
        try:
            _controller().enable_rf()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        _record_event("rf_enabled")
        return _controller().snapshot()

    @app.post("/api/rf/disable")
    def rf_disable() -> dict[str, Any]:
        _controller().disable_rf()
        _record_event("rf_disabled")
        return _controller().snapshot()

    @app.post("/api/match/manual")
    def match_manual(req: ManualModeRequest) -> dict[str, Any]:
        _controller().set_manual_mode(req.on)
        return {"manual_mode": req.on}

    @app.post("/api/match/tune")
    def match_tune(req: CapacityRequest) -> dict[str, Any]:
        try:
            _controller().set_tune_capacity(req.percent)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"tune_capacity": req.percent}

    @app.post("/api/match/load")
    def match_load(req: CapacityRequest) -> dict[str, Any]:
        try:
            _controller().set_load_capacity(req.percent)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"load_capacity": req.percent}

    @app.post("/api/recording/start")
    def recording_start(req: RecordingStartRequest) -> dict[str, Any]:
        rec = _recorder()
        if rec.state is RecorderState.RECORDING:
            raise HTTPException(status_code=409, detail="already recording")
        run_dir = rec.start(
            req.name,
            {
                "notes": req.notes,
                "backend": app.state.backend,
                "device": app.state.device_info,
                "limits": _controller().snapshot()["limits"],
            },
        )
        app.state.current_run = run_dir.name
        return {"run": run_dir.name}

    @app.post("/api/recording/stop")
    def recording_stop() -> dict[str, Any]:
        rec = _recorder()
        run = app.state.current_run
        rec.stop()
        app.state.current_run = None
        return {"run": run, "stopped": True}

    @app.get("/api/recording/status")
    def recording_status() -> dict[str, Any]:
        rec = _recorder()
        return {"active": rec.state is RecorderState.RECORDING, "run": app.state.current_run}

    # --- WebSocket -------------------------------------------------------------------------
    @app.websocket("/ws/telemetry")
    async def ws_telemetry(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                await ws.send_json(_status_payload())
                await asyncio.sleep(0.1)
        except WebSocketDisconnect:
            return

    def _record_event(label: str) -> None:
        rec = _recorder()
        if rec.state is RecorderState.RECORDING:
            rec.event(label)

    # --- static frontend -------------------------------------------------------------------
    dist = frontend_dist or _DEFAULT_FRONTEND_DIST
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")

    return app
