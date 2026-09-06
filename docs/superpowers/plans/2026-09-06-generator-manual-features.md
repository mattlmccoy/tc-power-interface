# Generator Manual Features Implementation Plan

> **For agentic workers:** red-green TDD for all backend logic; pure-UI pieces verified in the browser on :8010. Steps use `- [ ]`.

**Goal:** Port the remaining AG Plasma manual features into the tool: fix the DC/plasma-bias panel, tidy the ramp layout, and add auto-shutoff TIMER plus simulator-first PULSE, software PRESETS, and an LC/TC MODE selector.

**Architecture:** Backend loops mirror the existing `power_ramp.py` pattern — a small frozen `*Plan` + bounds, a `*Controller(controller,*,plan)` with `start/stop/tick/snapshot`, wired into `app.py` via `controller.add_listener(lambda _snap: x.tick(poll_interval_s))`, exposed at `/api/<feature>` (+ `/start`,`/stop`) and folded into `status[...]`. Persisted config (presets) mirrors `safety_store.py`/`thermal_store.py`. UI mirrors the existing panels. Nothing here ever enables RF; TIMER only *disables* it.

**Tech Stack:** Python 3.13 (uv) / FastAPI / pytest / ruff / mypy; React 18 + Vite + TS, `node --test`.

**Scope locked with user (2026-09-06):** ramp = layout/visual only; build = DC relabel + ramp layout + TIMER + sim-first PULSE + PRESETS + MODE.

## Manual grounding (data-contract citations — AG Plasma 27.12MHz UNIVERSAL TEMPLATE.pdf)

- **PULSE** (p20-21): `TIME ON` 0.001–9.995 s, `TIME OFF` 0.001–9.995 s ("no restriction which is shorter/longer"), duty cycle displayed, `ENABLE`→Y shows marker **P**. RF output pulses ON for TIME ON, OFF for TIME OFF.
- **RAMP** (p21, already built): `INIT` power, `RATE` 1–99 W/s, `ENABLE`→Y marker **R**.
- **PRESETS** (p22): 9 slots of tuner cap positions `LCAP`/`TCAP` 0–100%. *"Only available in ATUNE (automatic tuning)."* → our software presets recall in **MTUNE**, never ATUNE.
- **TIMER** (p22): enable Y/N, `1 min – 99 min`.
- **DC** (p22): *"Voltage reading (plasma bias) through the tuner. 0 – 999V."*
- **VDC LIMIT/SCALE** (p22, TUNER menu): power restricted so plasma bias ≤ VDC LIMIT (100–999V); SCALE 100x–500x (default 200). Context only — irrelevant while DC≈0.
- **MODE button** (p22): *"Pressing this button in MTUNE toggles quickly between LC and TC fields for faster tuning."* Front-panel MODE soft-button also toggles NORMAL/SERVICE screen (p19).

---

## Task 1 (P0): DC / plasma-bias panel relabel + explanation  — pure UI

**Files:** Modify `frontend/src/App.tsx` (Generator panel "DC BUS" block); maybe `frontend/src/styles.css`.

- [ ] Relabel "DC BUS" → "DC PROBE (PLASMA BIAS)"; keep the `dc_voltage` value + "V".
- [ ] Add a one-line note: reads 0 V for a non-plasma dielectric load (self-bias needs a plasma); a nonzero value would indicate arcing/partial discharge. Grounded in manual DC line.
- [ ] Browser-verify on :8010 (Generator panel shows the new label + note; value still 0 V).

## Task 2 (P0): Ramp section layout/visual only — pure UI

**Files:** Modify `frontend/src/App.tsx` (POWER RAMP block), `frontend/src/styles.css`.

- [ ] Restructure the cramped 2-row form: label the three inputs (Init W / Target W / Rate W/s) on an aligned grid; shrink the oversized brown "Start ramp" button to a normal control; keep Start/Stop behavior and the `startRamp`/`stopRamp` handlers unchanged.
- [ ] Browser-verify layout at desktop + narrow widths; confirm start/stop still call the same endpoints.

## Task 3 (P1): Auto-shutoff TIMER — backend TDD + UI

**Files:** Create `backend/tc_power_interface/control/timer.py`, `backend/tests/test_timer.py`; modify `backend/tc_power_interface/api/app.py`; frontend `telemetry.ts`/`api.ts`/`App.tsx`.

- [ ] **RED** test `elapse_disables_rf`: a `TimerController(fake, plan=TimerPlan(minutes=1))`; `start()`; feed `tick(dt)` totalling 60 s; assert `fake.disable_rf` called once and `snapshot()["done"]` True; before 60 s, not called.
- [ ] Run → fail (module missing).
- [ ] **GREEN** implement `TIMER_BOUNDS={"minutes":(1,99)}`, `TimerPlan(minutes:int)`, `TimerController` with `start/stop/tick/snapshot` (`running`,`done`,`elapsed_s`,`remaining_s`,`minutes`). `tick` accumulates; at `elapsed>=minutes*60` and still running → `controller.disable_rf()` once, set done. Never enables RF.
- [ ] Run → pass; add `stop()` resets running.
- [ ] Wire in `app.py`: `TimerBody`, `_timer()` accessor, listener `add_listener(lambda _s: timer.tick(poll_interval_s))`, `status["timer"]=snapshot()`, routes GET/PUT `/api/timer`, POST `/api/timer/start|stop`.
- [ ] Run full backend suite (ruff+mypy+pytest) → green.
- [ ] UI: `TimerStatus`/`TimerForm`/`TimerConfig` types; `api.timer/saveTimer/timerStart/timerStop`; a Timer panel (minutes input + Start/Stop + remaining countdown). Browser-verify start→countdown→(sim) RF-off.

## Task 4 (P1): Software PRESETS (manual recall) — backend TDD + UI

**Files:** Create `backend/tc_power_interface/control/presets.py`, `backend/tests/test_presets.py`; modify `app.py`; frontend types/api/App.

- [ ] **RED** test `save_then_recall_applies_caps_in_manual`: `PresetStore(path)`; `save(3, tune=42, load=61)`; `list()` shows slot 3; `recall(3, controller=fake)` → asserts `fake.set_manual_mode(True)` then `set_tune_capacity(42)`, `set_load_capacity(61)`; never calls any ATUNE/auto path.
- [ ] Run → fail.
- [ ] **GREEN** implement `PresetStore` (9 slots 1–9, each `{tune_cap_percent,load_cap_percent}` clamped 0–100, JSON persisted like `safety_store`), `save/recall/list/clear`. `recall` sets manual mode then applies both caps.
- [ ] Run → pass.
- [ ] Wire `app.py`: routes GET `/api/presets`, PUT `/api/presets/{slot}` (save current or explicit caps), POST `/api/presets/{slot}/recall`, DELETE `/api/presets/{slot}`; fold list into `status["presets"]`.
- [ ] Backend suite green.
- [ ] UI: 9-slot preset bank in the Matching Network panel — "save current caps to slot", "recall", each slot shows stored tune/load. Copy makes explicit these recall in **manual** mode (not the forbidden ATUNE). Browser-verify save→recall drives the cap fields.

## Task 5 (P2): Simulator-first PULSE — backend TDD + UI

**Files:** Create `backend/tc_power_interface/control/pulse.py`, `backend/tests/test_pulse.py`; modify `app.py`; frontend types/api/App.

- [ ] **RED** test `pulse_state_and_duty`: `pulse_state(elapsed_s, on_s, off_s)` → True within ON window, False within OFF, periodic; `duty(on_s,off_s)==on/(on+off)`.
- [ ] Run → fail.
- [ ] **GREEN** implement pure `pulse_state`/`duty` + `PULSE_BOUNDS` (on/off 0.001–9.995 s), `PulsePlan(on_s,off_s)`, `PulseController` that, while `running` and RF on, sets setpoint to the base power during ON and 0 during OFF (sim-only modulation); `snapshot()` includes `running,on_s,off_s,duty,output_on`.
- [ ] Run → pass.
- [ ] Wire `app.py` routes GET/PUT `/api/pulse`, POST `/api/pulse/start|stop`; `status["pulse"]`. Honest caveat: sim-first; real generator PULSE command unverified.
- [ ] UI: TIME ON/OFF (ms) + duty display + Start/Stop, in the Experimental tab (untested-on-hardware). "P" marker on the main power area when active. Browser-verify.

## Task 6 (P2): LC/TC MODE selector — pure UI

**Files:** Modify `frontend/src/App.tsx` (Matching Network panel), `styles.css`; small helper + test in `frontend/src/lib/instrument.ts` if any logic.

- [ ] Add an LC/TC "active field" toggle mirroring the manual's MODE button in MTUNE: selecting TC or LC makes the ↑/↓ fine-step keys act on that cap. Only meaningful in manual mode.
- [ ] If any pure logic (e.g., which cap a keypress targets), TDD it in `instrument.ts`; otherwise browser-verify the toggle + keyboard nudge.

---

## Self-review checklist
- [ ] Every backend feature: watched RED fail, then GREEN pass; ruff+mypy+pytest green.
- [ ] Nothing enables RF; TIMER only disables; presets recall in MANUAL mode (never ATUNE).
- [ ] PULSE/PRESETS/MODE labeled simulator-first / manual-only where the real path is unverified.
- [ ] Each UI change browser-verified on :8010.
