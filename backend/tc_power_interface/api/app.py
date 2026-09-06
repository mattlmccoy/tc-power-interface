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
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from tc_power_interface import __version__
from tc_power_interface.control.controller import Controller
from tc_power_interface.control.power_ramp import RAMP_BOUNDS, RampController, RampPlan
from tc_power_interface.control.safety import HARD_BOUNDS, SafetyLimits
from tc_power_interface.control.safety_store import load_limits, save_limits
from tc_power_interface.control.temperature import SimulatedThermalSource
from tc_power_interface.control.thermal_loop import THERMAL_BOUNDS, ThermalController, ThermalPlan
from tc_power_interface.control.thermal_store import load_plan, save_plan
from tc_power_interface.control.timer import TIMER_BOUNDS, TimerController, TimerPlan
from tc_power_interface.device import create_transport
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.integration.flir_link import FlirLink
from tc_power_interface.integration.rf_link_notifier import RfLinkNotifier
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


class FlirLinkBody(BaseModel):
    url: str
    enabled: bool


class SafetyLimitsBody(BaseModel):
    max_forward_w: float
    max_reflected_w: float
    temperature_c_trip: float


class ThermalPlanBody(BaseModel):
    target_c: float
    soak_s: float
    approach_band_c: float
    loop_ceiling_w: float
    max_step_w: float
    done_below_c: float


class ThermalStartBody(BaseModel):
    mode: str = "advisory"


class ThermalSourceBody(BaseModel):
    type: str
    url: str | None = None


class AutoLogBody(BaseModel):
    enabled: bool


class RampBody(BaseModel):
    init_w: float
    target_w: float
    rate_w_per_s: float


class TimerBody(BaseModel):
    minutes: float


def create_app(
    *,
    backend: str = "simulated",
    poll_interval_s: float = 0.5,
    experiments_root: Path | None = None,
    limits: SafetyLimits | None = None,
    transport_kwargs: dict[str, Any] | None = None,
    frontend_dist: Path | None = None,
    site_origin: str | None = None,
    flir_url: str | None = None,
) -> FastAPI:
    """Build the FastAPI app. The controller/device start in the lifespan."""
    experiments_root = Path(experiments_root or (Path.cwd() / "experiments"))
    # Explicit `limits` (tests) win; otherwise load the persisted, hard-bounded limits.
    active_limits = limits if limits is not None else load_limits(experiments_root)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        transport = create_transport(backend, **(transport_kwargs or {}))
        controller = Controller(
            CxnDevice(transport), limits=active_limits, poll_interval_s=poll_interval_s
        )
        recorder = TelemetryRecorder(experiments_root)
        flir_link = FlirLink(flir_url or "", enabled=bool(flir_url))
        controller.add_listener(RfLinkNotifier(flir_link).on_snapshot)
        controller.backend = backend
        thermal = ThermalController(
            controller, SimulatedThermalSource(),
            plan=load_plan(experiments_root, max_forward_w=active_limits.max_forward_w),
            mode="advisory",
        )
        # Tick the thermal loop first, so the recorder logs the freshly-computed loop curve.
        controller.add_listener(lambda _snap: thermal.tick(poll_interval_s))

        # Auto-log: on an RF-on rising edge, start a recording if one isn't already running. This
        # runs BEFORE the recorder listener so the first sample of the run is captured.
        app.state.auto_log = True
        _auto_prev = {"rf": False}

        def _auto_log(snap: dict[str, Any]) -> None:
            rf = bool((snap.get("telemetry") or {}).get("rf_on"))
            if (
                app.state.auto_log
                and rf
                and not _auto_prev["rf"]
                and recorder.state is not RecorderState.RECORDING
            ):
                run_dir = recorder.start(
                    f"RF_{datetime.now():%Y%m%d_%H%M%S}",
                    {"notes": "auto-logged on RF-on", "backend": backend, "auto": True},
                )
                app.state.current_run = run_dir.name
            _auto_prev["rf"] = rf

        controller.add_listener(_auto_log)
        controller.add_listener(
            lambda snap: recorder.record({**snap, "thermal": thermal.snapshot()})
        )
        app.state.thermal = thermal
        app.state.thermal_source = "simulated"

        # Software power ramp (init -> target at W/s); ticks from the poll, drives the setpoint.
        ramp = RampController(
            controller,
            plan=RampPlan.bounded(
                init_w=0, target_w=100, rate_w_per_s=10,
                max_forward_w=active_limits.max_forward_w,
            ),
        )
        controller.add_listener(lambda _snap: ramp.tick(poll_interval_s))
        app.state.ramp = ramp

        # Auto-shutoff timer (1-99 min -> RF off); ticks from the poll. Only ever disables RF.
        timer = TimerController(controller, plan=TimerPlan(minutes=10))
        controller.add_listener(lambda _snap: timer.tick(poll_interval_s))
        app.state.timer = timer

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
        app.state.flir_link = flir_link
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

    def _flir_link() -> FlirLink:
        return cast(FlirLink, app.state.flir_link)

    def _thermal() -> ThermalController:
        return cast(ThermalController, app.state.thermal)

    def _ramp() -> RampController:
        return cast(RampController, app.state.ramp)

    def _timer() -> TimerController:
        return cast(TimerController, app.state.timer)

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
            "thermal": {**_thermal().snapshot(), "source": app.state.thermal_source},
            "ramp": _ramp().snapshot(),
            "timer": _timer().snapshot(),
        }

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return _status_payload()

    @app.post("/api/setpoint")
    def set_setpoint(req: SetpointRequest) -> dict[str, Any]:
        applied = _controller().set_setpoint(req.watts)
        return {"requested_w": req.watts, "applied_w": applied}

    def _limits_payload() -> dict[str, Any]:
        lim = _controller().limits
        return {
            "max_forward_w": lim.max_forward_w,
            "max_reflected_w": lim.max_reflected_w,
            "temperature_c_trip": lim.temperature_c_trip,
            "bounds": {k: [v[0], v[1]] for k, v in HARD_BOUNDS.items()},
        }

    @app.get("/api/safety-limits")
    def get_safety_limits() -> dict[str, Any]:
        return _limits_payload()

    @app.put("/api/safety-limits")
    def put_safety_limits(body: SafetyLimitsBody) -> dict[str, Any]:
        new = SafetyLimits.bounded(
            max_forward_w=body.max_forward_w,
            max_reflected_w=body.max_reflected_w,
            temperature_c_trip=body.temperature_c_trip,
        )
        _controller().set_limits(new)
        save_limits(experiments_root, new)
        return _limits_payload()

    # --- thermal closed loop ---------------------------------------------------------------
    def _thermal_plan_payload() -> dict[str, Any]:
        p = _thermal().plan
        return {
            "target_c": p.target_c,
            "soak_s": p.soak_s,
            "approach_band_c": p.approach_band_c,
            "loop_ceiling_w": p.loop_ceiling_w,
            "max_step_w": p.max_step_w,
            "done_below_c": p.done_below_c,
            "bounds": {k: [v[0], v[1]] for k, v in THERMAL_BOUNDS.items()},
        }

    @app.get("/api/thermal/plan")
    def get_thermal_plan() -> dict[str, Any]:
        return _thermal_plan_payload()

    @app.put("/api/thermal/plan")
    def put_thermal_plan(body: ThermalPlanBody) -> dict[str, Any]:
        new = ThermalPlan.bounded(
            target_c=body.target_c,
            soak_s=body.soak_s,
            approach_band_c=body.approach_band_c,
            loop_ceiling_w=body.loop_ceiling_w,
            max_step_w=body.max_step_w,
            done_below_c=body.done_below_c,
            max_forward_w=_controller().limits.max_forward_w,
        )
        _thermal().plan = new
        save_plan(experiments_root, new)
        return _thermal_plan_payload()

    @app.post("/api/thermal/start")
    def thermal_start(body: ThermalStartBody) -> dict[str, Any]:
        th = _thermal()
        th.mode = body.mode
        th.start()
        return th.snapshot()

    @app.post("/api/thermal/stop")
    def thermal_stop() -> dict[str, Any]:
        th = _thermal()
        th.stop()
        return th.snapshot()

    @app.post("/api/thermal/arm")
    def thermal_arm() -> dict[str, Any]:
        th = _thermal()
        th.arm()
        return th.snapshot()

    @app.post("/api/thermal/disarm")
    def thermal_disarm() -> dict[str, Any]:
        th = _thermal()
        th.disarm()
        return th.snapshot()

    @app.post("/api/thermal/source")
    def thermal_source(body: ThermalSourceBody) -> dict[str, Any]:
        th = _thermal()
        if body.type == "flir":
            from tc_power_interface.integration.flir_temperature import FlirTemperatureSource

            th.source = FlirTemperatureSource(body.url or "")
            app.state.thermal_source = "flir"
        else:
            th.source = SimulatedThermalSource()
            app.state.thermal_source = "simulated"
        return {"source": app.state.thermal_source}

    # --- power ramp ------------------------------------------------------------------------
    def _ramp_payload() -> dict[str, Any]:
        p = _ramp().plan
        return {
            "init_w": p.init_w,
            "target_w": p.target_w,
            "rate_w_per_s": p.rate_w_per_s,
            "bounds": {k: [v[0], v[1]] for k, v in RAMP_BOUNDS.items()},
        }

    @app.get("/api/ramp")
    def get_ramp() -> dict[str, Any]:
        return _ramp_payload()

    @app.put("/api/ramp")
    def put_ramp(body: RampBody) -> dict[str, Any]:
        _ramp().plan = RampPlan.bounded(
            init_w=body.init_w,
            target_w=body.target_w,
            rate_w_per_s=body.rate_w_per_s,
            max_forward_w=_controller().limits.max_forward_w,
        )
        return _ramp_payload()

    @app.post("/api/ramp/start")
    def ramp_start() -> dict[str, Any]:
        _ramp().start()
        return _ramp().snapshot()

    @app.post("/api/ramp/stop")
    def ramp_stop() -> dict[str, Any]:
        _ramp().stop()
        return _ramp().snapshot()

    # --- auto-shutoff timer ----------------------------------------------------------------
    def _timer_payload() -> dict[str, Any]:
        return {
            "minutes": _timer().plan.minutes,
            "bounds": {k: [v[0], v[1]] for k, v in TIMER_BOUNDS.items()},
        }

    @app.get("/api/timer")
    def get_timer() -> dict[str, Any]:
        return _timer_payload()

    @app.put("/api/timer")
    def put_timer(body: TimerBody) -> dict[str, Any]:
        _timer().plan = TimerPlan.bounded(minutes=body.minutes)
        return _timer_payload()

    @app.post("/api/timer/start")
    def timer_start() -> dict[str, Any]:
        _timer().start()
        return _timer().snapshot()

    @app.post("/api/timer/stop")
    def timer_stop() -> dict[str, Any]:
        _timer().stop()
        return _timer().snapshot()

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

    @app.get("/api/recordings")
    def list_recordings() -> dict[str, Any]:
        root = experiments_root
        runs: list[dict[str, Any]] = []
        if root.is_dir():
            for d in sorted((p for p in root.iterdir() if p.is_dir()), reverse=True):
                csv_file = d / "telemetry.csv"
                if csv_file.is_file():
                    runs.append(
                        {
                            "run": d.name,
                            "complete": (d / "manifest.json").is_file(),
                            "size_bytes": csv_file.stat().st_size,
                        }
                    )
        return {"runs": runs}

    @app.get("/api/recordings/{run}/telemetry.csv")
    def download_recording(run: str) -> FileResponse:
        root = experiments_root.resolve()
        target = (root / run).resolve()
        if target.parent != root:  # reject path traversal / nested paths
            raise HTTPException(status_code=400, detail="invalid run name")
        csv_file = target / "telemetry.csv"
        if not csv_file.is_file():
            raise HTTPException(status_code=404, detail="no such recording")
        return FileResponse(csv_file, media_type="text/csv", filename=f"{run}_telemetry.csv")

    @app.get("/api/auto-log")
    def get_auto_log() -> dict[str, Any]:
        return {"enabled": bool(app.state.auto_log)}

    @app.put("/api/auto-log")
    def put_auto_log(body: AutoLogBody) -> dict[str, Any]:
        app.state.auto_log = body.enabled
        return {"enabled": app.state.auto_log}

    @app.get("/api/flir-link")
    def get_flir_link() -> dict[str, Any]:
        link = _flir_link()
        return {"url": link.url, "enabled": link.enabled, "last_result": link.last_result}

    @app.post("/api/flir-link")
    def set_flir_link(body: FlirLinkBody) -> dict[str, Any]:
        link = _flir_link()
        link.url = body.url.rstrip("/")
        link.enabled = body.enabled
        return {"url": link.url, "enabled": link.enabled, "last_result": link.last_result}

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
