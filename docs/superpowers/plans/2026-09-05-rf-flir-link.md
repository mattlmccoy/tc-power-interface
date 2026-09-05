# RF ↔ FLIR Event Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the RF system turns on/off, the FLIR Research Interface starts/annotates a thermal recording, with FLIR owning the stop-vs-keep policy, over a single HTTP contract between two separate programs.

**Architecture:** T&C detects RF on/off edges in its controller poll loop and POSTs a semantic event to a new FLIR endpoint (`POST /api/rf-link/event`). FLIR owns recording policy (auto-start on RF-on; on RF-off, mark and either stop or keep per a persisted setting). All T&C→FLIR calls are best-effort and never block or trip RF.

**Tech Stack:** Python (FastAPI, pytest) both sides; React/TS frontends (`node --test`); `httpx` for the T&C→FLIR client.

**Repos:** Part A tasks run in `flir-research-interface`; Part B/C in `tc-power-interface` (this repo). Spec: `docs/superpowers/specs/2026-09-05-rf-flir-link-design.md`.

---

## File Structure

**FLIR repo (`flir-research-interface`)**
- Create `backend/flir_research_interface/rf_link.py` — pure settings (load/save `.rf_link.json`) + pure policy `plan_rf_action(...)`.
- Create `backend/tests/test_rf_link.py` — settings + policy tests.
- Modify `backend/flir_research_interface/api/app.py` — add `RfLinkEvent`/`RfLinkSettings` models, `GET/PUT /api/rf-link/settings`, `POST /api/rf-link/event`, and `app.state.rf_link_owns_run`.
- Modify `backend/tests/test_api_rf_link.py` (create) — endpoint tests against the simulated camera.
- Modify `frontend/src/components/…` + `frontend/src/lib/api.ts` — small "RF link" settings UI (two toggles) — browser-verified.

**T&C repo (`tc-power-interface`, this repo)**
- Create `backend/tc_power_interface/integration/flir_link.py` — `FlirLink` (payload build + best-effort POST).
- Create `backend/tc_power_interface/integration/rf_link_notifier.py` — `RfLinkNotifier` edge detector.
- Create `backend/tests/test_flir_link.py`, `backend/tests/test_rf_link_notifier.py`.
- Modify `backend/tc_power_interface/api/app.py` — construct link+notifier in lifespan, `GET/POST /api/flir-link`.
- Modify `backend/tc_power_interface/api/server.py` — `--flir-url`.
- Modify `backend/tests/test_api.py` (or new `test_api_flir_link.py`) — `/api/flir-link` tests.
- Modify `frontend/src/App.tsx` + `frontend/src/lib/api.ts` — "Instruments" panel — browser-verified.

---

## PART A — FLIR repo (`flir-research-interface`)

> Run these in the FLIR repo on a branch, e.g. `feat/rf-link`.

### Task A1: RF-link settings (persisted sidecar)

**Files:**
- Create: `backend/flir_research_interface/rf_link.py`
- Test: `backend/tests/test_rf_link.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_rf_link.py
from flir_research_interface.rf_link import RfLinkSettings, load_settings, save_settings


def test_default_settings():
    s = RfLinkSettings()
    assert s.auto_start_on_rf_on is True
    assert s.stop_on_rf_off is False  # keep recording for cooldown by default


def test_settings_roundtrip(tmp_path):
    save_settings(tmp_path, RfLinkSettings(auto_start_on_rf_on=False, stop_on_rf_off=True))
    loaded = load_settings(tmp_path)
    assert loaded.auto_start_on_rf_on is False
    assert loaded.stop_on_rf_off is True


def test_load_missing_returns_defaults(tmp_path):
    assert load_settings(tmp_path) == RfLinkSettings()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_rf_link.py -q`
Expected: FAIL — `ModuleNotFoundError: flir_research_interface.rf_link`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/flir_research_interface/rf_link.py
"""RF-link: receive RF on/off events from the T&C tool and own the recording policy.

Pure settings + pure decision logic; the FastAPI wiring lives in api/app.py. Settings persist to
a git-ignored ``.rf_link.json`` sidecar in the experiments root, mirroring storage.py's pattern.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

CONFIG_NAME = ".rf_link.json"


@dataclass(frozen=True)
class RfLinkSettings:
    auto_start_on_rf_on: bool = True
    stop_on_rf_off: bool = False  # False = keep recording for cooldown


def load_settings(root: Path) -> RfLinkSettings:
    path = Path(root) / CONFIG_NAME
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return RfLinkSettings()
    return RfLinkSettings(
        auto_start_on_rf_on=bool(data.get("auto_start_on_rf_on", True)),
        stop_on_rf_off=bool(data.get("stop_on_rf_off", False)),
    )


def save_settings(root: Path, settings: RfLinkSettings) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / CONFIG_NAME).write_text(json.dumps(asdict(settings), indent=2))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_rf_link.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/flir_research_interface/rf_link.py backend/tests/test_rf_link.py
git commit -m "feat(rf-link): persisted RF-link settings sidecar"
```

### Task A2: RF-link policy (pure decision)

**Files:**
- Modify: `backend/flir_research_interface/rf_link.py`
- Test: `backend/tests/test_rf_link.py`

- [ ] **Step 1: Write the failing test** (append)

```python
from flir_research_interface.rf_link import plan_rf_action


def test_rf_on_when_idle_and_autostart_starts_and_marks():
    a = plan_rf_action(state="on", is_recording=False, link_owns=False,
                       settings=RfLinkSettings(auto_start_on_rf_on=True))
    assert a.mark is True and a.start is True and a.stop is False


def test_rf_on_when_already_recording_only_marks():
    a = plan_rf_action(state="on", is_recording=True, link_owns=False, settings=RfLinkSettings())
    assert a.mark is True and a.start is False and a.stop is False


def test_rf_off_keep_recording_by_default_marks_only():
    a = plan_rf_action(state="off", is_recording=True, link_owns=True,
                       settings=RfLinkSettings(stop_on_rf_off=False))
    assert a.mark is True and a.stop is False


def test_rf_off_stops_only_when_configured_and_link_owned():
    owned = plan_rf_action(state="off", is_recording=True, link_owns=True,
                           settings=RfLinkSettings(stop_on_rf_off=True))
    assert owned.stop is True
    operator = plan_rf_action(state="off", is_recording=True, link_owns=False,
                              settings=RfLinkSettings(stop_on_rf_off=True))
    assert operator.stop is False  # never stop an operator-owned run
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_rf_link.py -q`
Expected: FAIL — `ImportError: cannot import name 'plan_rf_action'`.

- [ ] **Step 3: Write minimal implementation** (append to `rf_link.py`)

```python
@dataclass(frozen=True)
class RfAction:
    mark: bool
    start: bool
    stop: bool


def plan_rf_action(*, state: str, is_recording: bool, link_owns: bool,
                   settings: RfLinkSettings) -> RfAction:
    """Decide what to do for an RF event. Pure; the caller performs the effects."""
    if state == "on":
        return RfAction(
            mark=True,
            start=settings.auto_start_on_rf_on and not is_recording,
            stop=False,
        )
    # state == "off"
    return RfAction(
        mark=True,
        start=False,
        stop=settings.stop_on_rf_off and is_recording and link_owns,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_rf_link.py -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/flir_research_interface/rf_link.py backend/tests/test_rf_link.py
git commit -m "feat(rf-link): pure RF-event policy (mark/start/stop)"
```

### Task A3: Settings endpoints (`GET/PUT /api/rf-link/settings`)

**Files:**
- Modify: `backend/flir_research_interface/api/app.py`
- Test: `backend/tests/test_api_rf_link.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_rf_link.py
from fastapi.testclient import TestClient
from flir_research_interface.api.app import create_app
from flir_research_interface.camera.simulated import SimulatedCameraBackend  # noqa: F401


def _client(tmp_path):
    app = create_app(default_backend="simulated", experiments_root=tmp_path)
    return TestClient(app)


def test_get_default_settings(tmp_path):
    with _client(tmp_path) as c:
        body = c.get("/api/rf-link/settings").json()
        assert body["auto_start_on_rf_on"] is True
        assert body["stop_on_rf_off"] is False


def test_put_settings_persists(tmp_path):
    with _client(tmp_path) as c:
        c.put("/api/rf-link/settings", json={"auto_start_on_rf_on": True, "stop_on_rf_off": True})
        assert c.get("/api/rf-link/settings").json()["stop_on_rf_off"] is True
```

> NOTE (verify first): confirm `create_app`'s exact keyword args and how `app.state.experiments_root` is set (app.py near line 736 / lifespan). Adjust `_client` to the real signature before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_rf_link.py -q`
Expected: FAIL — 404 on `/api/rf-link/settings`.

- [ ] **Step 3: Write minimal implementation** (in `create_app`, near the other `/api/...` routes)

```python
from flir_research_interface import rf_link  # top of file

class RfLinkSettingsBody(BaseModel):
    auto_start_on_rf_on: bool = True
    stop_on_rf_off: bool = False

@app.get("/api/rf-link/settings")
def get_rf_link_settings() -> dict[str, Any]:
    s = rf_link.load_settings(app.state.experiments_root)
    return {"auto_start_on_rf_on": s.auto_start_on_rf_on, "stop_on_rf_off": s.stop_on_rf_off}

@app.put("/api/rf-link/settings")
def put_rf_link_settings(body: RfLinkSettingsBody) -> dict[str, Any]:
    s = rf_link.RfLinkSettings(
        auto_start_on_rf_on=body.auto_start_on_rf_on, stop_on_rf_off=body.stop_on_rf_off
    )
    rf_link.save_settings(app.state.experiments_root, s)
    return {"auto_start_on_rf_on": s.auto_start_on_rf_on, "stop_on_rf_off": s.stop_on_rf_off}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_rf_link.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/flir_research_interface/api/app.py backend/tests/test_api_rf_link.py
git commit -m "feat(rf-link): settings API"
```

### Task A4: Event endpoint (`POST /api/rf-link/event`)

**Files:**
- Modify: `backend/flir_research_interface/api/app.py`
- Test: `backend/tests/test_api_rf_link.py`

Uses confirmed recorder API: `recorder().state` (RecorderState), `recorder().experiment_dir`,
`recorder().note_event("annotation", {...})`, the existing `_start_recording(req)` and
`_finalize_recording()` helpers, and `RecordingStartRequest`. Ownership: `app.state.rf_link_owns_run`.

- [ ] **Step 1: Write the failing test** (append)

```python
def test_rf_on_starts_recording_and_marks(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/camera/connect", json={"backend": "simulated"})  # start acquiring (verify path)
        r = c.post("/api/rf-link/event", json={"state": "on", "forward_w": 300.0})
        assert r.status_code == 200
        assert r.json()["recording"] is True
        # the RF ON mark is in the run's events
        status = c.get("/api/recording/status").json()
        assert status["state"] == "recording"


def test_rf_off_keeps_recording_by_default(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/camera/connect", json={"backend": "simulated"})
        c.post("/api/rf-link/event", json={"state": "on", "forward_w": 300.0})
        r = c.post("/api/rf-link/event", json={"state": "off", "reason": "operator"})
        assert r.json()["recording"] is True  # kept (stop_on_rf_off default False)


def test_rf_off_stops_when_configured(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/camera/connect", json={"backend": "simulated"})
        c.put("/api/rf-link/settings", json={"auto_start_on_rf_on": True, "stop_on_rf_off": True})
        c.post("/api/rf-link/event", json={"state": "on", "forward_w": 300.0})
        r = c.post("/api/rf-link/event", json={"state": "off", "reason": "operator"})
        assert r.json()["recording"] is False  # stopped
```

> NOTE (verify first): confirm how to make the simulated service acquire (the exact connect/acquire
> call), since `_start_recording` needs a running service. Mirror an existing recording test in
> `backend/tests/` for the precise setup, then finalize these fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_rf_link.py -q`
Expected: FAIL — 404 on `/api/rf-link/event`.

- [ ] **Step 3: Write minimal implementation** (in `create_app`; set `app.state.rf_link_owns_run = None` in the lifespan init alongside the other `app.state` fields)

```python
class RfLinkEvent(BaseModel):
    state: str  # "on" | "off"
    forward_w: float | None = None
    reflected_fraction: float | None = None
    reason: str | None = None
    source_ts_ns: int | None = None

@app.post("/api/rf-link/event")
async def rf_link_event(ev: RfLinkEvent) -> dict[str, Any]:
    settings = rf_link.load_settings(app.state.experiments_root)
    rec = recorder()
    is_recording = rec is not None and rec.state == RecorderState.RECORDING
    owns = is_recording and app.state.rf_link_owns_run == (
        rec.experiment_dir.name if rec and rec.experiment_dir else None
    )
    action = rf_link.plan_rf_action(
        state=ev.state, is_recording=is_recording, link_owns=owns, settings=settings
    )
    detail = ""
    # start (best-effort; camera may not be acquiring)
    if action.start:
        try:
            name = f"RF_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
            req = RecordingStartRequest(
                name=name,
                metadata={"trigger": "rf_link", "forward_w": ev.forward_w,
                          "reflected_fraction": ev.reflected_fraction},
            )
            rec2, exp_dir, _vis = await _start_recording(req)
            app.state.rf_link_owns_run = exp_dir.name
            rec = rec2
        except HTTPException as exc:
            detail = f"start failed: {exc.detail}"
    # mark
    if action.mark and recorder() is not None and recorder().state == RecorderState.RECORDING:
        label = "RF ON" if ev.state == "on" else "RF OFF"
        note = f"{ev.forward_w:.1f} W" if ev.state == "on" and ev.forward_w is not None else (
            ev.reason or "")
        recorder().note_event("annotation", {"name": label, "note": note})
    # stop
    if action.stop:
        await _finalize_recording()
        app.state.rf_link_owns_run = None
    rec_now = recorder()
    recording = rec_now is not None and rec_now.state == RecorderState.RECORDING
    return {
        "recording": recording,
        "run": rec_now.experiment_dir.name if recording and rec_now.experiment_dir else None,
        "action": {"mark": action.mark, "start": action.start, "stop": action.stop},
        "detail": detail,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_rf_link.py -q`
Expected: PASS. Then full gate: `uv run pytest -q && uv run ruff check . && uv run mypy flir_research_interface`.

- [ ] **Step 5: Commit**

```bash
git add backend/flir_research_interface/api/app.py backend/tests/test_api_rf_link.py
git commit -m "feat(rf-link): POST /api/rf-link/event applies the recording policy"
```

### Task A5: FLIR UI — "RF link" settings section (browser-verified)

**Files:**
- Modify: `frontend/src/lib/api.ts` — add `rfLinkSettings()` / `saveRfLinkSettings(s)` (GET/PUT `/api/rf-link/settings`, using the existing `req(...)` wrapper).
- Modify: a settings/controls component (e.g. under `frontend/src/components/`) — add a small "RF link" section with two checkboxes: "Auto-start recording on RF on" and "Stop recording on RF off (off = keep for cooldown)"; load on mount, PUT on change.

Not unit-testable (DOM); **verification gate:** `npm run build`, then run `fri-serve`, open the UI, toggle both, reload, confirm they persist (round-trips `.rf_link.json`).

- [ ] **Step 1:** Add the api.ts methods (2 functions mirroring existing `api.*` entries).
- [ ] **Step 2:** Add the "RF link" section with the two checkboxes wired to those methods.
- [ ] **Step 3:** `cd frontend && npm run build` — Expected: builds clean.
- [ ] **Step 4:** Browser check: toggle, reload, confirm persistence.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat(rf-link): FLIR UI settings for RF-triggered recording"
```

---

## PART B — T&C repo (`tc-power-interface`, this repo, branch `feat/flir-link`)

### Task B1: `FlirLink` — payload build + best-effort POST

**Files:**
- Create: `backend/tc_power_interface/integration/flir_link.py`
- Test: `backend/tests/test_flir_link.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_flir_link.py
from tc_power_interface.integration.flir_link import FlirLink, build_payload


def test_build_payload_on():
    p = build_payload(state="on", forward_w=300.0, reflected_fraction=0.01, reason="operator")
    assert p == {"state": "on", "forward_w": 300.0, "reflected_fraction": 0.01,
                 "reason": "operator"}


def test_disabled_link_does_not_post():
    calls = []
    link = FlirLink(url="http://localhost:8000", enabled=False,
                    _post=lambda url, body, timeout: calls.append(url))
    link.notify(state="on", forward_w=300.0, reflected_fraction=0.01, reason="operator")
    link.join()
    assert calls == []
    assert link.last_result["ok"] is None  # never attempted


def test_enabled_link_posts_and_records_success():
    calls = []
    link = FlirLink(url="http://localhost:8000", enabled=True,
                    _post=lambda url, body, timeout: calls.append((url, body)))
    link.notify(state="off", forward_w=0.0, reflected_fraction=0.0, reason="fault: arc")
    link.join()
    assert calls[0][0] == "http://localhost:8000/api/rf-link/event"
    assert calls[0][1]["reason"] == "fault: arc"
    assert link.last_result["ok"] is True


def test_post_failure_is_swallowed_and_recorded():
    def boom(url, body, timeout):
        raise OSError("connection refused")
    link = FlirLink(url="http://localhost:8000", enabled=True, _post=boom)
    link.notify(state="on", forward_w=1.0, reflected_fraction=0.0, reason="operator")
    link.join()
    assert link.last_result["ok"] is False
    assert "refused" in link.last_result["message"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_flir_link.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/tc_power_interface/integration/flir_link.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_flir_link.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/integration/flir_link.py backend/tests/test_flir_link.py
git commit -m "feat(flir-link): best-effort RF-event client"
```

### Task B2: `RfLinkNotifier` — RF edge detector

**Files:**
- Create: `backend/tc_power_interface/integration/rf_link_notifier.py`
- Test: `backend/tests/test_rf_link_notifier.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_rf_link_notifier.py
from tc_power_interface.integration.rf_link_notifier import RfLinkNotifier


class FakeLink:
    def __init__(self):
        self.calls = []

    def notify(self, *, state, forward_w, reflected_fraction, reason):
        self.calls.append((state, reason))


def snap(rf_on, state="connected", fault=None, fwd=0.0):
    return {"state": state, "fault_reasons": fault or [],
            "telemetry": {"rf_on": rf_on, "forward_w": fwd, "reflected_fraction": 0.0}}


def test_rising_edge_emits_on():
    link = FakeLink(); n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=False))
    n.on_snapshot(snap(rf_on=True, fwd=150.0))
    assert link.calls == [("on", "operator")]


def test_no_edge_no_emit():
    link = FakeLink(); n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_snapshot(snap(rf_on=True))
    assert link.calls == []


def test_falling_edge_operator_reason():
    link = FakeLink(); n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_snapshot(snap(rf_on=False))
    assert link.calls == [("off", "operator")]


def test_falling_edge_fault_reason():
    link = FakeLink(); n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_snapshot(snap(rf_on=False, state="fault", fault=["reflected fraction 0.5 > 0.1"]))
    assert link.calls[0][0] == "off"
    assert "fault:" in link.calls[0][1]


def test_missing_telemetry_ignored():
    link = FakeLink(); n = RfLinkNotifier(link)
    n.on_snapshot({"state": "connected", "fault_reasons": [], "telemetry": None})
    assert link.calls == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_rf_link_notifier.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/tc_power_interface/integration/rf_link_notifier.py
"""Detects RF on/off edges from controller snapshots and notifies the FLIR link.

Attach `on_snapshot` as a Controller listener. Emits exactly one notify per rf_on transition; a
falling edge that coincides with a FAULT carries the fault reasons.
"""
from __future__ import annotations

from typing import Any, Protocol


class _Link(Protocol):
    def notify(self, *, state: str, forward_w: float, reflected_fraction: float,
               reason: str) -> None: ...


class RfLinkNotifier:
    def __init__(self, link: _Link) -> None:
        self._link = link
        self._prev_rf_on: bool | None = None

    def on_snapshot(self, snapshot: dict[str, Any]) -> None:
        t = snapshot.get("telemetry")
        if t is None:
            return
        rf_on = bool(t.get("rf_on"))
        prev = self._prev_rf_on
        self._prev_rf_on = rf_on
        if prev is None or rf_on == prev:
            return
        if rf_on:
            reason = "operator"
            state = "on"
        else:
            state = "off"
            reasons = snapshot.get("fault_reasons") or []
            reason = f"fault: {'; '.join(reasons)}" if (
                snapshot.get("state") == "fault" and reasons) else "operator"
        self._link.notify(state=state, forward_w=float(t.get("forward_w", 0.0)),
                          reflected_fraction=float(t.get("reflected_fraction", 0.0)), reason=reason)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_rf_link_notifier.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/integration/rf_link_notifier.py backend/tests/test_rf_link_notifier.py
git commit -m "feat(flir-link): RF edge detector -> notifier"
```

### Task B3: Wire into the T&C app + `/api/flir-link` + `--flir-url`

**Files:**
- Modify: `backend/tc_power_interface/api/app.py` (lifespan: build `FlirLink` + `RfLinkNotifier`, `controller.add_listener(notifier.on_snapshot)`; add `GET/POST /api/flir-link`; add `flir_url`/`flir_enabled` params to `create_app`)
- Modify: `backend/tc_power_interface/api/server.py` (`--flir-url`)
- Test: `backend/tests/test_api_flir_link.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_flir_link.py
from fastapi.testclient import TestClient
from tc_power_interface.api.app import create_app


def _client(tmp_path, **kw):
    app = create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path, **kw)
    return TestClient(app)


def test_flir_link_defaults_disabled(tmp_path):
    with _client(tmp_path) as c:
        body = c.get("/api/flir-link").json()
        assert body["enabled"] is False


def test_set_flir_link_url_and_enable(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/flir-link", json={"url": "http://localhost:8000", "enabled": True})
        assert r.status_code == 200
        body = c.get("/api/flir-link").json()
        assert body["enabled"] is True
        assert body["url"] == "http://localhost:8000"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_flir_link.py -q`
Expected: FAIL — 404 on `/api/flir-link`.

- [ ] **Step 3: Write minimal implementation**

In `create_app` signature add `flir_url: str | None = None`. In the lifespan, after `controller` is built and before `controller.start()`:

```python
from tc_power_interface.integration.flir_link import FlirLink
from tc_power_interface.integration.rf_link_notifier import RfLinkNotifier

flir_link = FlirLink(flir_url or "", enabled=bool(flir_url))
controller.add_listener(RfLinkNotifier(flir_link).on_snapshot)
app.state.flir_link = flir_link
```

Add routes:

```python
class FlirLinkBody(BaseModel):
    url: str
    enabled: bool

@app.get("/api/flir-link")
def get_flir_link() -> dict[str, Any]:
    link = app.state.flir_link
    return {"url": link.url, "enabled": link.enabled, "last_result": link.last_result}

@app.post("/api/flir-link")
def set_flir_link(body: FlirLinkBody) -> dict[str, Any]:
    link = app.state.flir_link
    link.url = body.url.rstrip("/")
    link.enabled = body.enabled
    return {"url": link.url, "enabled": link.enabled, "last_result": link.last_result}
```

In `server.py`, add `parser.add_argument("--flir-url", default=None)` and pass `flir_url=args.flir_url` to `create_app`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_flir_link.py -q`
Expected: PASS. Then full gate: `uv run pytest -q && uv run ruff check . && uv run mypy tc_power_interface`.

- [ ] **Step 5: Commit**

```bash
git add backend/tc_power_interface/api/app.py backend/tc_power_interface/api/server.py backend/tests/test_api_flir_link.py
git commit -m "feat(flir-link): wire notifier + /api/flir-link + --flir-url"
```

### Task B4: T&C UI — "Instruments" panel (browser-verified)

**Files:**
- Modify: `frontend/src/lib/api.ts` — `flirLink()` (GET) and `setFlirLink(url, enabled)` (POST `/api/flir-link`).
- Modify: `frontend/src/App.tsx` — an "Instruments" panel in the control rail: FLIR URL input, enable checkbox, and a last-status line (`ok`/`failed` + time) from `last_result`; load from `/api/flir-link` (or the WS status if added) and POST on change.

Not unit-testable (DOM); **verification gate:** `npm run build`; then the end-to-end run in Task C1.

- [ ] **Step 1:** Add the two api.ts methods.
- [ ] **Step 2:** Add the Instruments panel wired to them.
- [ ] **Step 3:** `cd frontend && npm run build` — Expected: builds clean; `npm test` still green.
- [ ] **Step 4: Commit**

```bash
git add frontend/src/
git commit -m "feat(flir-link): T&C Instruments panel for the FLIR link"
```

---

## PART C — End-to-end verification

### Task C1: Live RF → FLIR run (both simulators)

Not a unit test; a real integration gate proving the contract across the two programs.

- [ ] **Step 1:** Start FLIR on :8000 with a simulated camera acquiring:
  `cd <flir>/backend && uv run fri-serve` (connect the simulated camera in its UI).
- [ ] **Step 2:** Start T&C on :8010 linked to FLIR:
  `cd backend && uv run tcp-serve --port 8010 --flir-url http://localhost:8000`
- [ ] **Step 3:** In the T&C UI, set a setpoint and turn **RF ON**. Confirm (FLIR UI or `curl localhost:8000/api/recording/status`) that a `RF_<ts>` recording started.
- [ ] **Step 4:** Turn **RF OFF**. With FLIR's `stop_on_rf_off` **off** (default), confirm recording **continues** (cooldown). Toggle the FLIR setting on, repeat, confirm it **stops**.
- [ ] **Step 5:** Open the finished run's `events.json`; confirm `RF ON`/`RF OFF` annotation marks with the power/reason. Record the outcome in `plan/notes.md`.

---

## Self-review notes

- **Spec coverage:** contract (A4/B1), FLIR policy + settings + UI (A1–A5), T&C edge detect + client + config + UI (B1–B4), best-effort/non-blocking (B1), fault-reason on RF-off (B2), keep-recording default (A1/A2), e2e (C1). ✅
- **Verify-first flags:** A3/A4 carry explicit "confirm FLIR internals" notes (create_app args, how the simulated camera acquires, `_start_recording`/`_finalize_recording` usage) — resolve by reading the real FLIR tests before finalizing fixtures.
- **Type consistency:** `RfLinkSettings`, `RfAction`, `plan_rf_action`, `FlirLink.notify(state,forward_w,reflected_fraction,reason)`, `RfLinkNotifier.on_snapshot(snapshot)` are used consistently across tasks.
