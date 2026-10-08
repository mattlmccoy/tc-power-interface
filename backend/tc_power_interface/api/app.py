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
import csv
import json
import logging
import math
import platform
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from tc_power_interface import __version__
from tc_power_interface.api.recording_files import router as recording_files_router
from tc_power_interface.api.scope_routes import router as scope_router
from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.controller import Controller
from tc_power_interface.control.core_watch import MAX_WATCH
from tc_power_interface.control.match_tuner import (
    MATCH_TUNER_BOUNDS,
    MatchTuner,
    MatchTunerPlan,
)
from tc_power_interface.control.power_ramp import RAMP_BOUNDS, RampController, RampPlan
from tc_power_interface.control.presets import NUM_SLOTS, PresetStore
from tc_power_interface.control.pulse import PULSE_BOUNDS, PulseController, PulsePlan
from tc_power_interface.control.rf_clock import RfClock
from tc_power_interface.control.run_mode import (
    RunMode,
    load_run_mode,
    parse_run_mode,
    save_run_mode,
)
from tc_power_interface.control.safety import HARD_BOUNDS, SafetyLimits
from tc_power_interface.control.safety_store import load_limits, save_limits
from tc_power_interface.control.temperature import SimulatedThermalSource
from tc_power_interface.control.thermal_loop import THERMAL_BOUNDS, ThermalController, ThermalPlan
from tc_power_interface.control.thermal_store import load_plan, load_source, save_plan, save_source
from tc_power_interface.control.timer import TIMER_BOUNDS, TimerController, TimerPlan
from tc_power_interface.device import create_transport
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.integration.control_telemetry import (
    ControlTelemetryPoster,
    HeartbeatGate,
    build_control_telemetry,
    build_power_heartbeat,
)
from tc_power_interface.integration.flir_link import FlirLink
from tc_power_interface.integration.flir_roi_temps import FlirPollingSource
from tc_power_interface.integration.rf_link_notifier import RfLinkNotifier
from tc_power_interface.integration.scope_hub import ScopeHub
from tc_power_interface.recording.recorder import RecorderState, TelemetryRecorder
from tc_power_interface.recording.replay_shadow import (
    DamagedRecordingError,
    has_roi_data,
    recorded_rois,
    replay_shadow,
    run_file,
)

logger = logging.getLogger(__name__)

#: A recording file that exists but cannot be parsed / read: a clean 422, never a 500.
_DAMAGE = (DamagedRecordingError, csv.Error, UnicodeError, OSError)

#: A failing cockpit observer is logged once, then at most once per this many seconds (it would
#: otherwise log every poll tick).
OBSERVER_LOG_EVERY_S = 60.0

API_VERSION = "0.1"
#: The RF clock is marked stale when the last good generator read is older than this (s).
_RF_CLOCK_STALE_S = 5.0
_DEFAULT_FRONTEND_DIST = Path(__file__).resolve().parents[2].parent / "frontend" / "dist"


def _read_frontend_version(package_json: Path) -> str | None:
    """The frontend release version from package.json — the single per-release source of truth the
    site also bakes into __APP_VERSION__. Reported as health.app_version so the banner can compare
    operator vs site like-for-like. None (never a stale/guessed value) if it can't be read; the
    banner treats unknown as 'not behind' and never nags."""
    try:
        version = json.loads(package_json.read_text()).get("version")
    except Exception:  # noqa: BLE001 - missing/unreadable/invalid package.json -> unknown version
        return None
    return version if isinstance(version, str) and version else None

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
    percent: float


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
    forward_caution_w: float = 400.0
    forward_danger_w: float = 500.0


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


class ThermalRoiBody(BaseModel):
    name: str


class WatchBody(BaseModel):
    names: list[str] = Field(default_factory=list, max_length=MAX_WATCH)


class RunModeBody(BaseModel):
    mode: str
    ladder_w: list[float] = Field(default_factory=list)
    fixed_w: float = 0
    fixed_min: float = 0


class AutoLogBody(BaseModel):
    enabled: bool


class ConnectBody(BaseModel):
    backend: str = "serial"
    serial: str | None = None  # required for backend="serial": the port device path


class RampBody(BaseModel):
    init_w: float
    target_w: float
    rate_w_per_s: float


class TimerBody(BaseModel):
    minutes: float


class PresetBody(BaseModel):
    tune: float
    load: float


class PulseBody(BaseModel):
    on_ms: float
    off_ms: float
    power_w: float


class MatchTunerBody(BaseModel):
    mode: str
    tune_step: float
    load_step: float
    guard: float


def thermal_extra(source: Any) -> dict[str, Any]:
    """Read-only extras surfaced alongside the thermal snapshot for the closed-loop hero: the
    control ROI's hottest pixel and a compact per-ROI roster. Both come from the FLIR polling
    source and are absent (None / []) on the simulated source or an older operator — never faked.
    The loop's own behaviour is unchanged; this only exposes already-computed values."""
    fn = getattr(source, "latest_roi_temps", None)
    return {
        "control_max_c": getattr(source, "latest_max_c", None),
        "roi_temps": fn() if callable(fn) else [],
    }


def run_mode_payload(m: RunMode) -> dict[str, Any]:
    """A run mode as JSON (the ladder tuple as a list)."""
    return {**asdict(m), "ladder_w": list(m.ladder_w)}


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
    # The frontend release version (package.json sits next to dist). running_app_version is read
    # once at startup (what this process started with); health.app_version re-reads it per request
    # (the release currently on disk, so a pull + rebuild without restart is reflected).
    package_json = (frontend_dist or _DEFAULT_FRONTEND_DIST).parent / "package.json"
    running_app_version = _read_frontend_version(package_json)
    # Explicit `limits` (tests) win; otherwise load the persisted, hard-bounded limits.
    active_limits = limits if limits is not None else load_limits(experiments_root)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # backend="none" boots IDLE (no device): the operator serves, and the user attaches a
        # generator at runtime via the connect popover (POST /api/connect). Any other backend
        # auto-connects at boot (tests/dev use "simulated").
        if backend == "none":
            controller = Controller(None, limits=active_limits, poll_interval_s=poll_interval_s)
        else:
            transport = create_transport(backend, **(transport_kwargs or {}))
            controller = Controller(
                CxnDevice(transport), limits=active_limits, poll_interval_s=poll_interval_s
            )
        recorder = TelemetryRecorder(experiments_root)
        scope_hub = ScopeHub(experiments_root, recorder)  # warn-only: never commands the generator
        app.state.scope_hub = scope_hub
        flir_link = FlirLink(flir_url or "", enabled=bool(flir_url))
        # RF on/off -> FLIR: announced from BOTH the API command (immediate; catches pulses shorter
        # than one telemetry poll) and the observed telemetry edge (front panel / faults), deduped.
        rf_notifier = RfLinkNotifier(flir_link)
        controller.add_listener(rf_notifier.on_snapshot)
        app.state.rf_notifier = rf_notifier
        # Per-tick control-telemetry POST to the FLIR run logger (shares the FLIR base + enabled
        # flag with the rf-link). Control ROI = the doped-part center circle (locked 2026-09-08).
        control_telemetry = ControlTelemetryPoster(flir_url or "", enabled=bool(flir_url))
        app.state.control_telemetry = control_telemetry
        heartbeat_gate = HeartbeatGate(period_s=1.0)  # power-only heartbeat cadence (manual runs)
        # Temperature source + control ROI: the operator's saved choice. No ROI name is invented
        # (the old hard-coded "circle_medium_small" vanished when the FLIR ROIs were redrawn, so the
        # loop silently read nothing and logged 0 C). Real hardware with a FLIR link defaults to
        # FLIR.
        src_cfg = load_source(
            experiments_root,
            default_type="flir" if (flir_url and backend != "simulated") else "simulated",
        )
        app.state.control_roi = src_cfg["roi"]
        app.state.watch_rois = src_cfg["watch"]
        app.state.ambient_roi = src_cfg["ambient"]  # room reference ROI (warm starts), or None
        # Run mode is display/bookkeeping only; a stale file is re-clamped to the real limit.
        app.state.run_mode = load_run_mode(
            experiments_root, max_forward_w=active_limits.max_forward_w
        )
        app.state.current_run = None  # set before the listeners can fire (the observer reads it)
        app.state.auto_run = None  # name of the run the auto-log started (None: none / operator's)
        app.state.flir_roi_url = (
            f"{(flir_url or '').rstrip('/')}/api/live/roi-temps" if flir_url else None
        )
        initial_source: Any = SimulatedThermalSource()
        app.state.thermal_source = "simulated"
        if src_cfg["type"] == "flir" and app.state.flir_roi_url:
            initial_source = FlirPollingSource(
                app.state.flir_roi_url, roi_name=app.state.control_roi
            )
            initial_source.start()
            app.state.thermal_source = "flir"
        controller.backend = backend
        thermal = ThermalController(
            controller, initial_source,
            plan=load_plan(experiments_root, max_forward_w=active_limits.max_forward_w),
            mode="advisory",
        )
        # Listener order (each poll tick, in registration order): rf_notifier -> auto-log ->
        # thermal tick (loop + cockpit observer + FLIR post) -> RF clock -> recorder -> scope hub
        # -> drivers.
        # Auto-log: on an RF-on rising edge, start a recording if one isn't already running. It
        # runs BEFORE the thermal tick, so the observer sees the new run id (and resets) on the
        # same tick, and BEFORE the recorder, so the run's first sample has a fresh estimate.
        # (A MANUAL POST /api/recording/start sets current_run from an HTTP thread between ticks, so
        # that run's first row can carry one tick of the previous shadow values — acceptable.)
        app.state.auto_log = True
        # `pending`: the latest RF-on edge was skipped because the previous run was still STOPPING
        # (draining a stalled disk). It is retried on later ticks while RF stays on, so a real RF
        # session never goes unrecorded; it is dropped when RF goes off or auto-log is disabled.
        # RF that was already on before auto-log was enabled never sets it (edge semantics).
        _auto_prev = {"rf": False, "pending": False}

        def _auto_log(snap: dict[str, Any]) -> None:
            rf = bool((snap.get("telemetry") or {}).get("rf_on"))
            if not rf or not app.state.auto_log:
                _auto_prev["pending"] = False
            elif not _auto_prev["rf"] or _auto_prev["pending"]:  # rising edge, or retrying a skip
                state = recorder.state
                if state is RecorderState.IDLE:
                    try:
                        run_dir = recorder.start(
                            f"RF_{datetime.now():%Y%m%d_%H%M%S}",
                            {"notes": "auto-logged on RF-on", "backend": backend, "auto": True},
                        )
                    except RuntimeError:  # a stop began since the state check: retry next tick
                        logger.warning("auto-log deferred: recorder busy")
                        _auto_prev["pending"] = True
                    else:
                        _auto_prev["pending"] = False
                        app.state.auto_run = run_dir.name
                        app.state.current_run = run_dir.name
                elif state is RecorderState.STOPPING:
                    _auto_prev["pending"] = True  # retry once the drain finishes
                else:  # already RECORDING (e.g. the operator's manual run): nothing to start
                    _auto_prev["pending"] = False
            _auto_prev["rf"] = rf

        controller.add_listener(_auto_log)

        # Cockpit observer (estimate + shadow loop + core watch). It is handed NUMBERS only — never
        # the controller — so it cannot command power, RF or caps.
        cockpit = CockpitObserver()
        app.state.cockpit = cockpit

        # Per-tick values shared between listeners: the FLIR roster is copied ONCE per tick (in
        # _thermal_tick) and reused by the recorder listener, which runs later in the same tick.
        tick_cache: dict[str, Any] = {"roi_temps": []}
        last_logged: dict[str, float] = {}  # failure kind -> monotonic time it was last logged

        def _log_cockpit_failure(kind: str) -> None:
            """Log a cockpit failure (with traceback) the first time, then at most once per
            OBSERVER_LOG_EVERY_S per kind — a persistent bug would otherwise log every poll tick."""
            now = time.monotonic()
            last = last_logged.get(kind)
            if last is None or now - last >= OBSERVER_LOG_EVERY_S:
                last_logged[kind] = now
                logger.exception("cockpit %s failed; continuing without it (rate-limited)", kind)

        def _observe(
            snap: dict[str, Any], roi_temps: list[dict[str, Any]], *, power_known: bool = True
        ) -> None:
            src = thermal.source  # swappable at runtime by POST /api/thermal/source
            cockpit.observe(
                t_s=time.monotonic(),
                telemetry=snap.get("telemetry") or {},
                part_roi=app.state.control_roi,
                part_temp_c=thermal.control_temp_c,
                temp_status=getattr(src, "status", "simulated"),
                roi_temps=roi_temps,
                watch=app.state.watch_rois,
                run_id=app.state.current_run,
                run_mode=app.state.run_mode,
                target_c=thermal.plan.target_c,
                ceiling_w=float(min(thermal.plan.loop_ceiling_w, controller.limits.max_forward_w)),
                power_known=power_known,
                ambient_roi=app.state.ambient_roi,
            )

        # Tick the thermal loop first, so the recorder logs the freshly-computed loop curve, then
        # POST the control-telemetry row to the FLIR logger (best-effort; never blocks the tick).
        # The observe path is shared by the generator's poll tick and the idle observer below. The
        # lock serialises them (the thermal loop and the cockpit are not thread-safe); the stamp of
        # the last poll tick (with controller.polling) keeps the idle observer silent while polling.
        observe_lock = threading.Lock()
        last_poll_tick = {"t": time.monotonic()}

        def _observe_roster(
            snap: dict[str, Any], *, power_known: bool = True
        ) -> list[dict[str, Any]]:
            """Copy the FLIR roster once and feed the cockpit observer; returns the roster ([] if
            it failed). A display-only observer must never stop the caller's loop."""
            try:
                roi_temps: list[dict[str, Any]] = thermal_extra(thermal.source)["roi_temps"]
            except Exception:  # noqa: BLE001
                _log_cockpit_failure("observer")
                return []
            try:
                _observe(snap, roi_temps, power_known=power_known)
            except Exception:  # noqa: BLE001
                _log_cockpit_failure("observer")
            return roi_temps

        def _thermal_tick(snap: dict[str, Any]) -> None:
            with observe_lock:
                last_poll_tick["t"] = time.monotonic()
                tick_cache["roi_temps"] = []  # never let a stale roster outlive a failed read
                thermal.tick(poll_interval_s)
                tick_cache["roi_temps"] = _observe_roster(snap)
            poster = app.state.control_telemetry
            if thermal.running and poster.enabled:
                body = build_control_telemetry(
                    thermal=thermal.snapshot(),
                    telemetry=snap.get("telemetry") or {},
                    roi=app.state.control_roi,
                    ts=datetime.now(UTC).isoformat(),
                )
                poster.post(body)
            elif poster.enabled and snap.get("telemetry") and heartbeat_gate.due():
                # Manual RF run (loop stopped, generator connected): a power-only heartbeat keeps
                # FLIR "engaged" and gives it an RF-power trace for EVERY run, not just closed-loop.
                # The running loop's row already carries these fields, so never both.
                poster.post(build_power_heartbeat(
                    telemetry=snap["telemetry"], ts=datetime.now(UTC).isoformat(),
                ))

        controller.add_listener(_thermal_tick)

        def _idle_observe() -> None:
            """No generator polling (backend "none", disconnected, link dropped): observe the FLIR
            temperature + watched cores anyway, so the cockpit never shows "ok" with no number or
            "nothing watched" while cores are configured. OBSERVE-ONLY: the stopped-loop read (never
            a loop step), the cockpit with RF off and power UNKNOWN (not 0 W). Never the
            controller, the device, the recorder or the FLIR poster. Silent while poll ticks are
            arriving."""
            with observe_lock:
                # The generator path owns the observe while its poll loop is live (a real ~1 s read
                # spaces ticks wider than the window) or a poll tick landed recently.
                recent = time.monotonic() - last_poll_tick["t"] < 2 * poll_interval_s
                if controller.polling or recent:
                    return
                # The read only (never a loop step), even with the loop started: with no generator
                # the loop cannot step, and skipping the read left control_temp_c None for good.
                thermal.observe(poll_interval_s)
                _observe_roster({"telemetry": {}}, power_known=False)  # no generator: power unknown

        idle_stop = threading.Event()

        def _idle_loop() -> None:
            while not idle_stop.wait(poll_interval_s):
                try:
                    _idle_observe()
                except Exception:  # noqa: BLE001 - the idle observer must never die silently
                    _log_cockpit_failure("idle observer")

        idle_thread = threading.Thread(target=_idle_loop, name="tcp-idle-observer", daemon=True)

        # RF on-time clock (display-only). After _auto_log so an auto-started run is seen on the
        # same tick; getattr because polling starts before app.state.current_run is first set.
        rf_clock = RfClock()
        app.state.rf_clock = rf_clock
        controller.add_listener(lambda snap: rf_clock.update(
            time.monotonic(),
            (snap.get("telemetry") or {}).get("rf_on"),
            getattr(app.state, "current_run", None),
        ))

        def _cockpit_fields() -> dict[str, Any]:
            """The cockpit's CSV columns, or {} (blank cells) if the observer fails: a cockpit bug
            must never cost the core telemetry row."""
            try:
                return cockpit.record_fields()
            except Exception:  # noqa: BLE001 - display-only extras; the row must still be written
                _log_cockpit_failure("record_fields")
                return {}

        controller.add_listener(lambda snap: recorder.record({
            **snap, "thermal": thermal.snapshot(), "cockpit": _cockpit_fields(),
            "roi_temps": tick_cache["roi_temps"], "scope": scope_hub.recording_fields(),
        }))
        controller.add_listener(scope_hub.on_snapshot)
        # (thermal_source was set above from the operator's saved choice)
        app.state.thermal = thermal

        # Software power ramp (init -> target at W/s); ticks from the poll, drives the setpoint.
        ramp = RampController(
            controller,
            plan=RampPlan.bounded(
                init_w=0, target_w=100, rate_w_per_s=10,
                max_forward_w=active_limits.max_forward_w,
            ),
        )
        controller.add_listener(
            lambda snap: ramp.tick(
                poll_interval_s, rf_on=bool((snap.get("telemetry") or {}).get("rf_on"))
            )
        )
        app.state.ramp = ramp

        # Auto-shutoff timer (1-99 min -> RF off); ticks from the poll. Only ever disables RF.
        timer = TimerController(controller, plan=TimerPlan(minutes=10))
        controller.add_listener(lambda _snap: timer.tick(poll_interval_s))
        app.state.timer = timer

        # Software tuner-cap presets (recall applies caps in MANUAL mode, never ATUNE).
        app.state.presets = PresetStore(experiments_root)

        # Simulator-first PULSE (gate the setpoint on/off); ticks from the poll. Never enables RF.
        pulse = PulseController(
            controller,
            plan=PulsePlan.bounded(
                on_ms=1000, off_ms=1000, power_w=100,
                max_forward_w=active_limits.max_forward_w,
            ),
        )
        controller.add_listener(lambda _snap: pulse.tick(poll_interval_s))
        app.state.pulse = pulse

        # Software matching auto-tuner (perturb-and-observe on reverse power). Default advisory:
        # it recommends but never drives until put into auto AND armed. It NEVER enables RF.
        match_tuner = MatchTuner(controller, plan=MatchTunerPlan())

        def _mt_telemetry(snap: dict[str, Any]) -> dict[str, Any]:
            t = snap.get("telemetry") or {}
            tel: dict[str, Any] = {
                "rf_on": bool(t.get("rf_on", False)),
                "manual_mode": bool(t.get("manual_mode", True)),
                # Telemetry already carries reflected_fraction (= reverse/forward); the tuner
                # minimizes exactly this.
                "reverse_fraction": float(t.get("reflected_fraction") or 0.0),
            }
            if t.get("tune_cap_percent") is not None:
                tel["tune_cap_percent"] = float(t["tune_cap_percent"])
            if t.get("load_cap_percent") is not None:
                tel["load_cap_percent"] = float(t["load_cap_percent"])
            return tel

        controller.add_listener(lambda snap: match_tuner.tick(poll_interval_s, _mt_telemetry(snap)))
        app.state.match_tuner = match_tuner

        # Start polling, but tolerate a device that won't connect (generator off / not plugged in):
        # keep serving so limits/plan can be configured before the hardware is attached. The
        # controller simply stays DISCONNECTED; settings routes don't touch the device.
        if backend == "none":
            device_info = {}  # idle boot: no device until the user connects
        else:
            try:
                controller.start()
                device_info = controller.identify()
            except Exception:  # noqa: BLE001 - device may be absent; serve anyway
                device_info = {}

        app.state.controller = controller
        # When the controller auto-drops a lost link (generator off / cable pulled while idle), run
        # the same cleanup as the manual POST /api/disconnect — halt every driver and clear the
        # device metadata — so nothing is left "running" with no device or naming a gone generator.
        controller.on_link_dropped = _on_link_dropped
        # Every tune/load cap command (operator, preset, auto match-tuner) becomes a run event with
        # its source + the readback just before, so in-run cap moves can be reconstructed later.
        controller.on_cap_command = lambda ev: _record_event("cap_command", ev)
        app.state.recorder = recorder
        app.state.device_info = device_info
        app.state.backend = backend
        app.state.connected_port = None
        app.state.flir_link = flir_link
        idle_thread.start()
        try:
            yield
        finally:
            idle_stop.set()
            idle_thread.join(timeout=2.0)
            app.state.scope_hub.disconnect()
            recorder.stop()  # no-op when idle; waits out a stop already draining
            controller.stop()

    app = FastAPI(title="T&C Power Interface", version=__version__, lifespan=lifespan)
    install_cross_origin_policy(app, site_origin=site_origin)

    @app.middleware("http")
    async def _no_cache_html(request, call_next):  # type: ignore[no-untyped-def]
        # The SPA shell (index.html) must never be cached, or the browser keeps loading stale UI
        # after a redeploy. Hashed JS/CSS under /assets keep their normal (immutable) caching.
        response = await call_next(request)
        if response.headers.get("content-type", "").startswith("text/html"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def _controller() -> Controller:
        return cast(Controller, app.state.controller)

    def _recorder() -> TelemetryRecorder:
        return cast(TelemetryRecorder, app.state.recorder)

    def _flir_link() -> FlirLink:
        return cast(FlirLink, app.state.flir_link)

    def _thermal() -> ThermalController:
        return cast(ThermalController, app.state.thermal)

    def _available_rois() -> list[str]:
        """The live FLIR roster (control-ROI candidates); empty unless a FLIR source is set."""
        fn = getattr(_thermal().source, "available_rois", None)
        return cast(list[str], fn()) if callable(fn) else []

    def _rf_command(*, on: bool, reason: str = "operator") -> None:
        """Announce an accepted RF on/off command to the FLIR link immediately (see RfLinkNotifier:
        a pulse shorter than one telemetry poll would otherwise never reach FLIR)."""
        tel = _controller().latest_telemetry
        cast(RfLinkNotifier, app.state.rf_notifier).on_command(
            on=on,
            forward_w=float(tel.forward_w) if tel else 0.0,
            reflected_fraction=float(tel.reflected_fraction) if tel else 0.0,
            reason=reason,
        )

    def _ramp() -> RampController:
        return cast(RampController, app.state.ramp)

    def _timer() -> TimerController:
        return cast(TimerController, app.state.timer)

    def _presets() -> PresetStore:
        return cast(PresetStore, app.state.presets)

    def _pulse() -> PulseController:
        return cast(PulseController, app.state.pulse)

    def _match_tuner() -> MatchTuner:
        return cast(MatchTuner, app.state.match_tuner)

    def _stop_all_features() -> None:
        """Halt every driver (ramp/pulse/timer/thermal/tuner). Used on disconnect, disarm and
        E-STOP so a feature can never be left 'running' with no device or while read-only."""
        for stop in (
            _ramp().stop,
            _pulse().stop,
            _timer().stop,
            _thermal().stop,
            _match_tuner().stop,
        ):
            try:
                stop()
            except Exception:  # noqa: BLE001 - best-effort halt; never block disconnect/disarm
                pass

    def _on_link_dropped() -> None:
        """Fired by the controller when it auto-drops a lost link (generator turned off / unplugged
        while idle). Mirror the app-state cleanup of the manual POST /api/disconnect: halt the
        drivers AND clear the device metadata, so the UI shows a clean 'no device / disconnected'
        instead of the pill going grey while the top bar still names the (now absent) generator."""
        _stop_all_features()
        app.state.rf_clock.reset_link()  # the next generator starts with an unknown RF state
        app.state.backend = "none"
        app.state.connected_port = None
        app.state.device_info = {}
        # The generator is gone: an auto-started run would sit open with no rows (2026-10-06, run
        # 20261006_164701, 14+ min). A run the operator started by hand is theirs to stop. Off the
        # poll thread: the stop joins the writer (up to 5 s under a Dropbox stall).
        _stop_auto_run("recording_stopped_link_lost", background=True)

    def _stop_auto_run(event: str, *, background: bool) -> None:
        """Stop the auto-log-started run (never an operator-started one) because the generator is
        gone. The run is named up front and stopped atomically by name, so a stale decision can
        never stop a newer manual run."""
        run = app.state.auto_run
        if run is None:
            return

        def _do() -> None:
            try:
                if _recorder().stop_if_current(run, event) is not None:
                    logger.info("stopped auto-started run %s (%s)", run, event)
            except Exception:  # noqa: BLE001 - best-effort; the run is also finalized at shutdown
                logger.exception("could not stop auto-started run %s", run)
            finally:
                if app.state.auto_run == run:
                    app.state.auto_run = None
                if app.state.current_run == run:
                    app.state.current_run = None

        if background:
            threading.Thread(target=_do, name="tcp-stop-auto-run", daemon=True).start()
        else:
            _do()

    def _presets_payload() -> dict[str, Any]:
        return {
            "slots": {str(k): v for k, v in _presets().list().items()},
            "num_slots": NUM_SLOTS,
        }

    # --- REST ------------------------------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "version": __version__,
            # release on disk now (falls back to the startup value if unreadable) -> update banner
            "app_version": _read_frontend_version(package_json) or running_app_version,
            "running_app_version": running_app_version,  # release this process started with
            "api_version": API_VERSION,
            "backend": app.state.backend,
            "platform": platform.platform(),
        }

    def _status_payload() -> dict[str, Any]:
        rec = _recorder()
        ctrl_snap = _controller().snapshot()
        link_age = ctrl_snap["link"]["last_ok_age_s"]
        rf_clock_snap = app.state.rf_clock.snapshot(
            time.monotonic(),
            link_ok=link_age is not None and link_age <= _RF_CLOCK_STALE_S,
            attached=ctrl_snap["state"] in ("connected", "fault"),
        )
        return {
            "device": app.state.device_info,
            "controller": ctrl_snap,
            "recording": {
                "active": rec.state is RecorderState.RECORDING,
                "run": app.state.current_run,
                "run_path": None if rec.run_dir is None else str(rec.run_dir.resolve()),
                "experiments_root": str(experiments_root.resolve()),
            },
            "thermal": {
                **_thermal().snapshot(),
                "source": app.state.thermal_source,
                "control_roi": app.state.control_roi,
                "ambient_roi": app.state.ambient_roi,
                # why there is / isn't a control temperature (ok, no_roi_selected, roi_not_in_feed,
                # ...)
                "temp_status": getattr(_thermal().source, "status", "simulated"),
                "available_rois": _available_rois(),
                **thermal_extra(_thermal().source),
                **app.state.cockpit.snapshot(),  # "shadow" + "watch"
                "run_mode": run_mode_payload(app.state.run_mode),
                # D12: the temperature loop may not drive power until the core interlock exists.
                "engage": {"available": False, "reason": "core interlock not built yet"},
            },
            "ramp": _ramp().snapshot(),
            "timer": _timer().snapshot(),
            "presets": _presets_payload(),
            "pulse": _pulse().snapshot(),
            "match_tuner": _match_tuner().snapshot(),
            "scope": app.state.scope_hub.snapshot(),
            # Surface the VNA-session interlock at the top level too (mirrors `match_tuner`), so the
            # frontend banner/panel read `status.vna_session`; the same block stays in `controller`.
            "vna_session": ctrl_snap["vna_session"],
            "rf_clock": rf_clock_snap,
        }

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return _status_payload()

    @app.get("/api/discovery")
    def discovery() -> dict[str, Any]:
        """List serial ports the operator can connect to, plus the current connection (if any)."""
        from serial.tools import list_ports

        # Skip macOS pseudo-ports that are never a generator (keeps the popover uncluttered).
        noise = ("Bluetooth-Incoming-Port", "debug-console", "wlan-debug")
        ports = [
            {"device": p.device, "description": p.description or "", "hwid": p.hwid or ""}
            for p in list_ports.comports()
            if not any(n in p.device for n in noise)
        ]
        ctrl = _controller()
        connected = None
        if getattr(app.state, "backend", "none") != "none" and ctrl.device is not None:
            connected = {
                "backend": app.state.backend,
                "port": getattr(app.state, "connected_port", None),
            }
        return {"ports": ports, "connected": connected}

    @app.post("/api/connect")
    def connect(req: ConnectBody) -> dict[str, Any]:
        """Attach a generator at runtime. Never enables RF (read-only until the operator turns RF
        on; the built-in auto-tuner is never engaged). Returns the fresh status snapshot."""
        try:
            if req.backend == "serial":
                if not req.serial:
                    raise HTTPException(400, "a serial port is required to connect over serial")
                device = CxnDevice(create_transport("serial", port=req.serial))
            elif req.backend == "simulated":
                device = CxnDevice(create_transport("simulated"))
            else:
                raise HTTPException(400, f"unknown backend {req.backend!r}")
            app.state.rf_clock.reset_link()  # a new link starts with an unknown RF state
            _controller().attach_device(device, backend=req.backend)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - surface a clean error to the popover
            raise HTTPException(503, f"could not connect: {exc}") from exc
        app.state.backend = req.backend
        app.state.connected_port = req.serial if req.backend == "serial" else None
        app.state.device_info = _controller().identify()
        return _status_payload()

    @app.post("/api/disconnect")
    def disconnect() -> dict[str, Any]:
        """Detach the current generator (RF off, lease released, port closed) and go idle. Halts
        every driver first so nothing is left 'running' with no device attached."""
        _stop_all_features()
        _stop_auto_run("recording_stopped_disconnected", background=False)
        _controller().detach_device()
        app.state.rf_clock.reset_link()
        app.state.backend = "none"
        app.state.connected_port = None
        app.state.device_info = {}
        return _status_payload()

    @app.post("/api/setpoint")
    def set_setpoint(req: SetpointRequest) -> dict[str, Any]:
        try:
            applied = _controller().set_setpoint(req.watts)
        except RuntimeError as exc:  # not armed / no device
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"requested_w": req.watts, "applied_w": applied}

    def _limits_payload() -> dict[str, Any]:
        lim = _controller().limits
        return {
            "max_forward_w": lim.max_forward_w,
            "max_reflected_w": lim.max_reflected_w,
            "temperature_c_trip": lim.temperature_c_trip,
            "forward_caution_w": lim.forward_caution_w,
            "forward_danger_w": lim.forward_danger_w,
            "bounds": {
                **{k: [v[0], v[1]] for k, v in HARD_BOUNDS.items()},
                "forward_caution_w": [0, 600],
                "forward_danger_w": [0, 600],
            },
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
            forward_caution_w=body.forward_caution_w,
            forward_danger_w=body.forward_danger_w,
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
        # D12 (2026-10-07): no loop may drive power until the core interlock exists. The
        # ThermalController can still run "auto" (unit tests), but the API only ever starts it in
        # advisory mode — this is the ONLY route that sets thermal.mode. Refused before any state
        # changes, so a rejected request leaves the loop exactly as it was.
        if body.mode == "auto":
            raise HTTPException(
                status_code=409,
                detail=(
                    "auto is locked until the core interlock is built; advisory mode still works"
                ),
            )
        if body.mode != "advisory":
            raise HTTPException(status_code=422, detail=f"unknown thermal mode: {body.mode!r}")
        th = _thermal()
        th.mode = "advisory"
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
        # Stop a previous polling source's background thread before swapping the source out.
        prev_stop = getattr(th.source, "stop", None)
        if callable(prev_stop):
            prev_stop()
        if body.type == "flir":
            base = (body.url or "").rstrip("/")
            roi_url = base if base.endswith("/api/live/roi-temps") else f"{base}/api/live/roi-temps"
            src = FlirPollingSource(roi_url, roi_name=app.state.control_roi)
            src.start()  # begin polling GET /api/live/roi-temps in the background (closes the gap
            th.source = src  # where the live consumer was defined but never started)
            app.state.thermal_source = "flir"
        else:
            th.source = SimulatedThermalSource()
            app.state.thermal_source = "simulated"
        _save_source()
        return {"source": app.state.thermal_source}

    @app.get("/api/thermal/rois")
    def thermal_rois() -> dict[str, Any]:
        return {
            "available_rois": _available_rois(),
            "control_roi": app.state.control_roi,
            "ambient_roi": app.state.ambient_roi,
        }

    def _save_source() -> None:
        save_source(experiments_root, {
            "type": app.state.thermal_source, "roi": app.state.control_roi,
            "watch": app.state.watch_rois, "ambient": app.state.ambient_roi,
        })

    @app.post("/api/thermal/roi")
    def thermal_roi(body: ThermalRoiBody) -> dict[str, Any]:
        # The operator selects which live FLIR ROI to control on (ROIs change print-to-print).
        app.state.control_roi = body.name or None
        setter = getattr(_thermal().source, "set_roi", None)
        if callable(setter):
            setter(app.state.control_roi)
        _save_source()
        return {"control_roi": app.state.control_roi, "available_rois": _available_rois()}

    @app.post("/api/thermal/ambient")
    def thermal_ambient(body: ThermalRoiBody) -> dict[str, Any]:
        # The room reference ROI: read at RF on when the part was NOT seen at rest in the minute
        # before (a warm start). Display/estimate only; it never commands anything. "" = none.
        app.state.ambient_roi = body.name or None
        _save_source()
        return {"ambient_roi": app.state.ambient_roi, "available_rois": _available_rois()}

    @app.post("/api/thermal/watch")
    def thermal_watch(body: WatchBody) -> dict[str, Any]:
        # Core-watch ROIs: display/record only. More than MAX_WATCH names is a 422 (WatchBody).
        app.state.watch_rois = list(dict.fromkeys(n for n in body.names if n))[:MAX_WATCH]
        _save_source()
        return {"watch": app.state.watch_rois}

    @app.get("/api/run-mode")
    def get_run_mode() -> dict[str, Any]:
        return run_mode_payload(app.state.run_mode)

    @app.post("/api/run-mode")
    def set_run_mode(body: RunModeBody) -> dict[str, Any]:
        # Bookkeeping only: the run mode never sets power.
        try:
            m = parse_run_mode(body.model_dump(), max_forward_w=_controller().limits.max_forward_w)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        app.state.run_mode = m
        save_run_mode(experiments_root, m)
        return run_mode_payload(m)

    @app.post("/api/thermal/engage")
    def thermal_engage() -> dict[str, Any]:
        # D12: the temperature loop may not drive power until the core interlock exists.
        # Refused server-side so a UI bug can never unlock it.
        raise HTTPException(
            status_code=409, detail="locked: the core interlock is not built yet"
        )

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

    # --- tuner-cap presets (software; recall applies caps in MANUAL mode, never ATUNE) ------
    @app.get("/api/presets")
    def get_presets() -> dict[str, Any]:
        return _presets_payload()

    @app.put("/api/presets/{slot}")
    def put_preset(slot: int, body: PresetBody) -> dict[str, Any]:
        try:
            _presets().save(slot, tune=body.tune, load=body.load)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _presets_payload()

    @app.post("/api/presets/{slot}/recall")
    def recall_preset(slot: int) -> dict[str, Any]:
        try:
            applied = _presets().recall(slot, _controller())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"applied": applied}

    @app.delete("/api/presets/{slot}")
    def delete_preset(slot: int) -> dict[str, Any]:
        try:
            _presets().clear(slot)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _presets_payload()

    # --- pulse (simulator-first; real generator PULSE command unverified) ------------------
    def _pulse_payload() -> dict[str, Any]:
        p = _pulse().plan
        return {
            "on_ms": p.on_ms,
            "off_ms": p.off_ms,
            "power_w": p.power_w,
            "bounds": {k: [v[0], v[1]] for k, v in PULSE_BOUNDS.items()},
        }

    @app.get("/api/pulse")
    def get_pulse() -> dict[str, Any]:
        return _pulse_payload()

    @app.put("/api/pulse")
    def put_pulse(body: PulseBody) -> dict[str, Any]:
        _pulse().plan = PulsePlan.bounded(
            on_ms=body.on_ms,
            off_ms=body.off_ms,
            power_w=body.power_w,
            max_forward_w=_controller().limits.max_forward_w,
        )
        return _pulse_payload()

    @app.post("/api/pulse/start")
    def pulse_start() -> dict[str, Any]:
        _pulse().start()
        return _pulse().snapshot()

    @app.post("/api/pulse/stop")
    def pulse_stop() -> dict[str, Any]:
        _pulse().stop()
        return _pulse().snapshot()

    # --- software matching auto-tuner (advisory/auto; arm-gated; never enables RF) --------------
    def _match_tuner_payload() -> dict[str, Any]:
        p = _match_tuner().plan
        return {
            "mode": p.mode,
            "tune_step": p.tune_step,
            "load_step": p.load_step,
            "guard": p.guard,
            "bounds": {k: [v[0], v[1]] for k, v in MATCH_TUNER_BOUNDS.items()},
        }

    @app.get("/api/match-tuner")
    def get_match_tuner() -> dict[str, Any]:
        return _match_tuner_payload()

    @app.put("/api/match-tuner")
    def put_match_tuner(body: MatchTunerBody) -> dict[str, Any]:
        _match_tuner().plan = MatchTunerPlan.bounded(
            mode=body.mode,
            tune_step=body.tune_step,
            load_step=body.load_step,
            guard=body.guard,
        )
        return _match_tuner_payload()

    @app.post("/api/match-tuner/start")
    def match_tuner_start() -> dict[str, Any]:
        _match_tuner().start()
        return _match_tuner().snapshot()

    @app.post("/api/match-tuner/stop")
    def match_tuner_stop() -> dict[str, Any]:
        _match_tuner().stop()
        return _match_tuner().snapshot()

    @app.post("/api/match-tuner/arm")
    def match_tuner_arm() -> dict[str, Any]:
        _match_tuner().arm()
        return _match_tuner().snapshot()

    @app.post("/api/match-tuner/disarm")
    def match_tuner_disarm() -> dict[str, Any]:
        _match_tuner().disarm()
        return _match_tuner().snapshot()

    @app.post("/api/vna-session/begin")
    def vna_session_begin() -> dict[str, Any]:
        """Enter VNA pre-run auto-tune mode (RF off). While active, POST /api/rf/enable is refused
        (409). Forces RF off best-effort; E-STOP / RF-OFF stay available."""
        _controller().begin_vna_session()
        _record_event("vna_session_begin")
        return _status_payload()

    @app.post("/api/vna-session/end")
    def vna_session_end() -> dict[str, Any]:
        """Leave VNA-tune mode; RF is allowed again (arm/connected/not-faulted gates still
        apply)."""
        _controller().end_vna_session()
        _record_event("vna_session_end")
        return _status_payload()

    @app.post("/api/vna-session/heartbeat")
    def vna_session_heartbeat() -> dict[str, Any]:
        """Refresh VNA-session liveness. A stale heartbeat is reported in the snapshot but never
        clears the session — only /api/vna-session/end does."""
        _controller().vna_heartbeat()
        return _status_payload()

    @app.post("/api/rf/enable")
    def rf_enable() -> dict[str, Any]:
        try:
            _controller().enable_rf()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        _rf_command(on=True)  # generator accepted the enable -> tell FLIR now, not next poll
        _record_event("rf_enabled")
        return _controller().snapshot()

    @app.post("/api/rf/disable")
    def rf_disable() -> dict[str, Any]:
        _controller().disable_rf()
        _rf_command(on=False)
        _record_event("rf_disabled")
        return _controller().snapshot()

    @app.post("/api/arm")
    def arm() -> dict[str, Any]:
        """Take control of the connected device (unlocks RF/setpoint/caps). Never enables RF."""
        try:
            _controller().arm()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        _record_event("armed")
        return _status_payload()

    @app.post("/api/disarm")
    def disarm() -> dict[str, Any]:
        """Drop control: RF off, halt every driver, and re-lock the control commands. Always
        allowed. Stopping the drivers here is what keeps a ramp from being 'stuck on' when you
        disarm (or disconnect) before turning it off."""
        _controller().disarm()
        _stop_all_features()
        _record_event("disarmed")
        return _status_payload()

    @app.post("/api/estop")
    def estop() -> dict[str, Any]:
        """Emergency stop: RF off, setpoint 0, halt drivers (ramp/pulse/timer/thermal/tuner).
        Bypasses the arm gate and works in any state."""
        _controller().estop()
        _rf_command(on=False, reason="e-stop")  # FLIR's timeline should show WHY RF dropped
        _stop_all_features()
        _record_event("estop")
        return {"ok": True, "rf": "off"}

    @app.post("/api/clear-fault")
    def clear_fault() -> dict[str, Any]:
        """Clear a latched FAULT once telemetry is healthy again (the UI's 'Clear fault' button). RF
        stays off — re-enable it explicitly. A no-op if a live trip condition still holds; `cleared`
        reports whether it left FAULT, and `fault_reasons` shows what still holds it if not."""
        cleared = _controller().clear_fault()
        if cleared:
            _record_event("fault_cleared")
        snap = _controller().snapshot()
        return {"cleared": cleared, "state": snap["state"], "fault_reasons": snap["fault_reasons"]}

    @app.post("/api/match/manual")
    def match_manual(_req: ManualModeRequest) -> dict[str, Any]:
        # Tuner is locked to MANUAL — the automatic (ATUNE) path does not exist.
        _controller().set_manual_mode(True)
        return {"manual_mode": True}

    @app.post("/api/match/tune")
    def match_tune(req: CapacityRequest) -> dict[str, Any]:
        try:
            _controller().set_tune_capacity(req.percent, source="operator")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:  # not armed / no device
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"tune_capacity": req.percent}

    @app.post("/api/match/load")
    def match_load(req: CapacityRequest) -> dict[str, Any]:
        try:
            _controller().set_load_capacity(req.percent, source="operator")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:  # not armed / no device
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"load_capacity": req.percent}

    @app.post("/api/recording/start")
    def recording_start(req: RecordingStartRequest) -> dict[str, Any]:
        rec = _recorder()
        if rec.state is RecorderState.RECORDING:
            raise HTTPException(status_code=409, detail="already recording")
        try:
            run_dir = rec.start(
                req.name,
                {
                    "notes": req.notes,
                    "backend": app.state.backend,
                    "device": app.state.device_info,
                    "limits": _controller().snapshot()["limits"],
                },
            )
        except RuntimeError as exc:  # previous run still finalizing, or lost a start race
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        app.state.auto_run = None  # operator-chosen: a link drop / disconnect leaves it alone
        app.state.current_run = run_dir.name
        return {"run": run_dir.name}

    @app.post("/api/recording/stop")
    def recording_stop() -> dict[str, Any]:
        rec = _recorder()
        run = app.state.current_run
        rec.stop()
        if app.state.current_run == run:  # a new run may already have started once we went IDLE
            app.state.current_run = None
            app.state.auto_run = None
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
                csv_file = run_file(d, "telemetry.csv")
                if csv_file is None:
                    continue
                try:
                    size = csv_file.stat().st_size
                except OSError:  # vanished or unreadable mid-listing: one bad run never breaks it
                    continue
                runs.append(
                    {
                        "run": d.name,
                        "path": str(d.resolve()),
                        "complete": (d / "manifest.json").is_file(),
                        "size_bytes": size,
                        "has_roi_data": has_roi_data(d),  # never raises
                    }
                )
        return {"runs": runs}

    def _run_dir(run: str) -> Path:
        """The run's directory directly under the experiments root: 400 on any path traversal or
        nested path (incl. a symlink out of the root) or a null byte, 404 if it does not exist."""
        if "\x00" in run:
            raise HTTPException(status_code=400, detail="invalid run name")
        try:
            root = experiments_root.resolve()
            target = (root / run).resolve()
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="invalid run name") from exc
        if target.parent != root:  # reject path traversal / nested paths
            raise HTTPException(status_code=400, detail="invalid run name")
        if not target.is_dir():
            raise HTTPException(status_code=404, detail="no such recording")
        return target

    @app.get("/api/recordings/{run}/telemetry.csv")
    def download_recording(run: str) -> FileResponse:
        csv_file = run_file(_run_dir(run), "telemetry.csv")  # None for a symlink out of the run
        if csv_file is None:
            raise HTTPException(status_code=404, detail="no such recording")
        return FileResponse(csv_file, media_type="text/csv", filename=f"{run}_telemetry.csv")

    @app.get("/api/recordings/{run}/rois")
    def recording_rois(run: str) -> dict[str, Any]:
        run_dir = _run_dir(run)
        try:
            return {"rois": recorded_rois(run_dir)}
        except _DAMAGE as exc:
            raise HTTPException(status_code=422, detail=f"damaged recording: {exc}") from exc

    @app.get("/api/recordings/{run}/events.json")
    def recording_events(run: str) -> FileResponse:
        path = run_file(_run_dir(run), "events.json")
        if path is None:  # written only on a clean stop; a symlink out of the run is absent
            raise HTTPException(status_code=404, detail="no events for this recording")
        return FileResponse(path, media_type="application/json")

    @app.get("/api/recordings/{run}/shadow")
    def recording_shadow(
        run: str, roi: str, target: float, ceiling: float = 200.0
    ) -> dict[str, Any]:
        """Re-run the live shadow loop (same code) over the recording on ``roi``. Sync on purpose:
        FastAPI runs it in the threadpool, so a long replay never blocks the event loop."""
        if not (math.isfinite(target) and math.isfinite(ceiling)) or ceiling < 0:
            raise HTTPException(status_code=422, detail="target and ceiling must be finite numbers")
        run_dir = _run_dir(run)
        try:
            return replay_shadow(run_dir, roi=roi, target_c=target, ceiling_w=ceiling)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except _DAMAGE as exc:
            raise HTTPException(status_code=422, detail=f"damaged recording: {exc}") from exc

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
        # The control-telemetry poster shares the FLIR base + enabled flag with the rf-link.
        ct = app.state.control_telemetry
        ct.url = body.url.rstrip("/")
        ct.enabled = body.enabled
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

    def _record_event(label: str, data: dict[str, Any] | None = None) -> None:
        rec = _recorder()
        if rec.state is RecorderState.RECORDING:
            rec.event(label, data)

    app.include_router(scope_router)
    app.include_router(recording_files_router)

    # --- static frontend -------------------------------------------------------------------
    dist = frontend_dist or _DEFAULT_FRONTEND_DIST
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")

    return app
