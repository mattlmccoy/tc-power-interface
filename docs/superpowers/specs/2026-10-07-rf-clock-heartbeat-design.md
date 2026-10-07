# RF on-time clock + link heartbeat: design and plan

**Date:** 2026-10-07 · **Branch:** `feat/heartbeat-clock` (off `main` @ b943f4a) · **Status:** approved by Matt

## Why

1. The operator wants to know how long the generator has been on: both the current continuous burn and the total RF-on time in the current recording.
2. When values aren't changing, the dashboard looks frozen. That is scary, because it looks the same as a dropped link. We need visible proof that (a) the operator is still polling the generator and getting replies, and (b) the browser is still receiving updates from the operator.

## Evidence (current code, main @ b943f4a)

- `control/controller.py`:
  - `_tick()` (~299) does one read per poll (default 0.5 s). A good read sets `_read_failures = 0` (~316) and `_last_sample_monotonic` (~326).
  - Read failures increment `_read_failures` in `_on_read_failure` (~436).
  - `snapshot()` exposes `telemetry.rf_on` and `host_timestamp_ns`.
  - On main, the v0.16.2 hotfix makes `rf_on` true when forward power is above 1 W.
- `api/app.py`:
  - `app.state.current_run` is set when a recording starts (~335, ~1050) and cleared on stop (~425, ~1058).
  - Listeners are registered with `controller.add_listener` (~257–390).
  - `_status_payload()` builds the status dict, which `/ws/telemetry` pushes every 0.1 s.
- `frontend/src/hooks/useOperator.ts:259`: `ws.onmessage` → `setStatus(s)`.
- `frontend/src/App.tsx:53`: `<header className="topbar">` with brand/device/build, spacer, view tabs, and the connect pill.

## Design

### Backend

1. **`control/rf_clock.py`** (pure, new): `RfClock`.
   - `update(now_s: float, rf_on: bool | None, run: str | None) -> None`
     - Called once per controller poll, with `time.monotonic()`, telemetry `rf_on` (or None when there is no telemetry), and `app.state.current_run`.
     - On a rising edge it sets `_since = now_s`.
     - On a falling edge it sets `_last_burn_s = now_s - _since` and `_since = None`.
     - While RF is on and `run` is not None, it accumulates `run_rf_on_s += now_s - _prev_now`, using the previous call's time, so on-time is never double-counted.
     - When `run` changes to a different non-None id, `run_rf_on_s` resets to 0.
     - `rf_on is None` (no telemetry) adds no accumulation and doesn't change edges.
   - `snapshot(now_s, link_ok: bool) -> dict` returns:
     - `rf_on` (last known value, or None)
     - `burn_s` (`now_s - _since` while on, else None)
     - `last_burn_s`
     - `run_rf_on_s`, which includes the in-progress partial burn since the last update while on and running
     - `run`
     - `stale` (`not link_ok`)
   - Durations are computed at snapshot time, so the clock ticks smoothly at the 10 Hz WebSocket rate, not the 2 Hz poll rate.
2. **Link block** in `Controller.snapshot()` (the only change to the controller):
   - Add a successful-read counter `_poll_seq`, incremented where a good read is processed (next to `_read_failures = 0`).
   - `snapshot()["link"] = {"poll_seq": int, "last_ok_age_s": float | None, "read_failures": int}`
     - `last_ok_age_s` is monotonic now minus `_last_sample_monotonic`, or None if no good read yet.
     - Read the fields under the existing `_lock` pattern used by snapshot. Do not add lock nesting with `_io_lock`.
3. **Wiring** in `api/app.py`, minimal:
   - Create `rf_clock = RfClock()` and put it on `app.state`.
   - Add a listener `lambda snap: rf_clock.update(time.monotonic(), (snap.get("telemetry") or {}).get("rf_on"), app.state.current_run)`. If telemetry is None, pass None.
   - `_status_payload()` gains `"rf_clock": app.state.rf_clock.snapshot(time.monotonic(), link_ok=…)`. `link_ok` is true when `controller.snapshot()["link"]["last_ok_age_s"]` is not None and ≤ 5.0 s.

### Frontend

4. **`lib/heartbeat.ts`** (pure, new):
   - `fmtDuration(s)`: `"—"` for null or non-finite, `m:ss` under 1 h (e.g. `4:12`), `h:mm:ss` from 1 h up.
   - `genHealth(link, connected)`: returns `{tone: "ok" | "slow" | "dead" | "unknown", label}`.
     - `unknown` when the generator isn't connected or there's no link block (older backend)
     - `ok` when age ≤ 1.5 s and `read_failures` is 0
     - `slow` when 1.5 < age ≤ 5 s, or `read_failures` ≥ 1
     - `dead` when age > 5 s or there's no good read
     - The label is the age, formatted `0.4 s`.
   - `appHealth(msSinceLastMessage)`: `ok` ≤ 2000 ms, `dead` above.
   - `rfClockView(rfClock)`: the top-bar text and tone.
     - On: `RF ON 4:12 · run 18:40`, live tone.
     - Off: `RF off · last 4:12 · run 18:40`, muted.
     - Stale: `RF ? · no data`, dim and warn.
     - Missing: null, so nothing renders.
5. **`components/LinkHeartbeat.tsx`**: two small LEDs labelled `GEN` and `APP`.
   - Each blinks for about 150 ms when its counter changes: `poll_seq` for GEN, a message counter for APP. Use a CSS animation re-keyed on the counter value.
   - The LED color comes from the tone, and the age label sits next to GEN.
   - A tooltip explains: "GEN: operator↔generator poll (the request is also the keepalive). APP: browser↔operator updates".
6. **`components/RfClock.tsx`**: renders `rfClockView` in mono, using the existing tokens (`--live`, `--muted`, `--warn`).
7. **`useOperator.ts`**:
   - In `ws.onmessage`, record a message counter and `lastMsgAt = performance.now()`, and expose both.
   - Run a 250 ms interval tick so APP can go dead when messages stop. A stopped socket has no `onmessage` to re-render the page.
8. **`App.tsx` top bar**: insert `<RfClock/>` and `<LinkHeartbeat/>` after the spacer and before the view tabs. They show on every page.

## Testing (red-green)

- `backend/tests/test_rf_clock.py`:
  - edges and burn length
  - `last_burn_s`
  - run accumulation across on/off/on
  - run reset on a new run id
  - no accumulation while `run` is None or `rf_on` is None
  - smooth `snapshot` partial accumulation
  - `stale` flag
- `backend/tests/test_controller_link.py`:
  - `poll_seq` increments per good read
  - `last_ok_age_s` is None before the first read
  - `read_failures` reflects failures, using the `_FlakyDevice`/TimeoutError approach from `test_controller_setpoint_memory.py`
- API test: `/api/status` has `rf_clock` and `controller.link` blocks, using the simulated backend.
- `frontend/src/lib/heartbeat.test.ts`: `fmtDuration` boundaries (59 s, 60 s, 3599 s, 3600 s), `genHealth` thresholds and unknown cases, `appHealth`, and `rfClockView` for on/off/stale/missing.
- Browser check on a simulated instance (not :8010):
  - GEN blinks about 2×/s and APP blinks
  - enable RF on the simulator, so the clock counts and run total counts while recording
  - RF off shows "last …"
  - stop the simulated instance's polling, or kill the backend process. APP should go red within 2 s. If there's a test hook for a read failure, GEN should go amber or red.
- Gates: backend pytest, `mypy --strict`, `ruff check .` (repo-wide is clean now and must stay at 0); frontend `npm test` and `npm run build`.

## Deploy

This is a backend change, so it needs one service restart (`launchctl kickstart -k gui/$UID/com.tcpower.operator`) after merge, fast-forward and `uv sync` + `npm run build` in the main checkout. Restart ONLY when `/api/status` shows RF off and no active recording, because a restart drops the generator link. Then reconnect the scope via the API (`POST /api/scope/connect`). It reads its saved settings.
