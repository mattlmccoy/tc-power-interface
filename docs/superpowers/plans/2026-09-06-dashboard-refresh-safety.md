# Dashboard Refresh + Safety Hardening Plan

> Red-green TDD for all logic (codec, ATUNE guard, E-stop); pure-UI verified in the browser on :8010.

**Goal:** Harden the safety-critical control paths (never emit ATUNE; add an E-stop) and refresh the
dashboard per Matt's feedback (limit ticks on gauges, bigger readout, digital=analog set, compact
reverse bar, RF-on-top layout, startup-order guidance, consistent "Reverse" wording, 0.1% caps).

**Grounding (PyMeasure tccxn.py + AG Plasma manual, verified 2026-09-06):**
- Tuner mode: `TM 02`=manual, `TM 01`=automatic(ATUNE). ATUNE is FORBIDDEN — our stack must never emit `TM 01`.
- Caps: 0-100% at **0.1%** resolution (read = raw/10; write = %×10 as 2-byte). Current write is 1-byte 1%.
- Serial control: `BC` request-control + `BP` ping keepalive (already done); no REM/LOC needed.
- Terminology: PyMeasure/device/manual use **reverse** (RP).

---

## Task 1 (P0): Never emit ATUNE — lock manual mode  [codec+device+controller, TDD]
**Files:** `protocol/codec.py`, `device/cxn.py`, `control/controller.py`, `tests/test_manual_lock.py`, `api/app.py`.
- [ ] RED: `test_controller_forces_manual_on_connect` — after `connect()`, device received `TM 02`; and `set_manual_mode(False)` never sends `TM 01` (stays manual).
- [ ] GREEN: Controller `connect()` calls `device.set_manual_mode(True)`; `Controller.set_manual_mode` ignores False (always True, logs a warning). `CxnDevice.set_manual_mode` keeps only the manual path used; add `codec.cmd_manual_mode` guard test that our code never generates `TM 01`.
- [ ] API `/api/match/manual`: accept the call but always force manual (no automatic); UI toggle becomes a locked "MANUAL (locked)" indicator.

## Task 2 (P0): Finer caps — 0.1% resolution  [codec+device+controller+api, TDD]
**Files:** `protocol/codec.py`, `device/cxn.py`, `control/controller.py`, `api/app.py`, `tests/test_codec_caps.py`.
- [ ] RED: `cmd_tune_capacity(42.5)` encodes `TC 00 02` + `(425).to_bytes(2)`; round-trips through `parse_gt` to 42.5. Same for load (`TC 00 01`). Out-of-range raises.
- [ ] GREEN: change `cmd_tune_capacity`/`cmd_load_capacity` to `float` → `round(pct*10)` 2-byte; `CxnDevice`/`Controller.set_tune_capacity`/`set_load_capacity` take `float`; API `CapacityRequest.percent: float`.
- [ ] UI: cap inputs step 0.1, slider step 0.1, −/+ bump 0.1 (hold-repeat), MODE fine-step 0.1.

## Task 3 (P0): E-STOP  [controller+api, TDD; big UI button]
**Files:** `control/controller.py` or `api/app.py`, `tests/test_api_estop.py`, `App.tsx`, `styles.css`.
- [ ] RED: `POST /api/estop` → RF off, setpoint 0, and ramp/pulse/timer/thermal all stopped/disarmed.
- [ ] GREEN: endpoint calls `disable_rf()`, `set_setpoint(0)`, `ramp.stop()`, `pulse.stop()`, `timer.stop()`, `thermal.stop()`.
- [ ] UI: big red **E-STOP** button, prominent (top of controls). No confirm (it's a safety stop).

## Task 4 (P1): Gauge limit ticks tied to Settings  [Gauge.tsx, browser-verify]
- [ ] `Gauge` gets optional `limit?` → colored radial tick + shaded over-limit arc at `limit` (replacing hardcoded 400/500). Reuse tested `gaugeAngle`.
- [ ] Forward/Requested/Load pass `limit={max_forward_w}`; Reverse passes `limit={max_reflected_w}`. Max stays 600.

## Task 5 (P1): Bigger gauge readout  [styles.css]
- [ ] Bump `.gauge-readout` font-size (~22→32px), keep unit smaller.

## Task 6 (P1): Digital readout = analog set  [App.tsx]
- [ ] Digital cards become Requested / Forward / Reverse / Load (drop Heat-sink temp — already in Generator panel). "Requested" uses the same setpoint value as the analog gauge.

## Task 7 (P1): "Reverse" everywhere  [App.tsx]
- [ ] Relabel user-facing "Reflected power" → "Reverse power" (digital card, the meter panel, plot legend). Internal `reflected_fraction` stays.

## Task 8 (P1): Compact reverse-power meter  [App.tsx, styles.css]
- [ ] Constrain the full-width reverse bar to a compact fixed-width meter (~360px) with warn/trip ticks marked on the bar, readable at a glance.

## Task 9 (P1): Layout — RF on top, manual tuning under, E-stop prominent  [App.tsx]
- [ ] Reorder the controls column: E-STOP + RF ON/OFF at the top, then Matching network (manual tuning), then setpoint/ramp.

## Task 10 (P1): Startup-order guidance on the page  [App.tsx]
- [ ] A startup-sequence panel/banner (generator → AIT, full checklist), prominent when `no device`.

## Verify
- [ ] ruff + mypy + pytest (backend) green; frontend build + node tests green; browser-verify each UI change on :8010.
