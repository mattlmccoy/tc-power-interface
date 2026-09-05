# Task Plan: T&C Power RF Generator Control Interface (`tc_power_interface`)

## Goal
Build a working prototype control tool for the T&C Power Conversion AG-series RF generator
(native USB / CXN serial dialect), mirroring the FLIR Research Interface architecture, with a
simulator-first, safety-first design that can eventually consume the FLIR thermal stream for
in-situ closed-loop control.

## Guiding constraints (non-negotiable)
- **Simulator-first.** Everything must run and be tested with NO hardware attached.
- **Safety-first.** RF defaults OFF. No automatic RF-enable in this prototype. A protection
  layer commands RF off on fault/timeout. Real serial is behind an explicit opt-in.
- **Documented protocol only.** Implement the CXN protocol exactly as documented in the
  PyMeasure `tccxn.py` reference (MIT). Mark every byte-layout detail not yet confirmed on THIS
  physical unit as unverified (see [[notes.md]] "Data-contract status").
- **TDD.** Every codec function and state-machine transition gets a failing test first.
- **Mirror FLIR.** Same stack, layout, naming, and conventions so it reads as the same family.

## Phases
- [x] Phase 0: Recon — FLIR architecture + exact CXN protocol spec (captured in notes.md)
- [x] Phase 1: Project scaffold (uv package, pyproject, ruff/mypy/pytest, dir layout, git)
- [x] Phase 2: Protocol codec (TDD) — 29 tests green (framing, checksum, builders, parsers, Status)
- [x] Phase 3: Device backend abstraction + byte-level simulator (TDD) — 11 tests green
- [x] Phase 4: Controller with control-lease keepalive (poll <2 s) — 10 tests green
- [x] Phase 5: Safety / protection evaluator (TDD) — 11 tests green; wired into controller (RF off on trip)
- [x] Phase 6: FastAPI backend + WebSocket telemetry + REST + run recording — 7 tests green; live-verified
- [x] Phase 7: Frontend (Vite/React/TS, FLIR theme) — 9 lib tests green; built + browser-verified live
- [x] Phase 8: FLIR-integration foundation — advisory thermal evaluator + FLIR frame-header parser (6 tests)
- [x] Phase 9: Verify (backend 81 + frontend 9 green, live browser run), README + docs written

## Key Questions
1. Is the physical unit's byte layout identical to the CXN reference? (UNVERIFIED — needs a
   read-only hardware capture before trusting on real RF.)
2. setpoint write unit ambiguity: read divides by 10, write sends raw int (see notes). Confirm on hw.
3. What COM port / USB descriptor does the unit enumerate as? (For the real-serial adapter.)

## Decisions Made
- Package name `tc_power_interface`, distribution `tc-power-interface`, script prefix `tcp-`
  (tcp = T&C Power; e.g. `tcp-serve`, `tcp-probe`, `tcp-monitor`). Mirrors `flir_research_interface`/`fri-`.
- No runtime dependency on PyMeasure (heavy: numpy/pandas/pyvisa; Python-3.14 wheel risk). Own clean
  codec, grounded in the documented spec. PyMeasure `tccxn.py` kept only as an offline reference.
- Python pin `>=3.11,<3.14` (uv-managed). Runtime deps: fastapi, uvicorn[standard], websockets, pyserial.
- Real hardware access is opt-in (`--serial <port>`); default backend is the simulator.

## Errors Encountered
- (none yet)

## Status
**All 9 phases complete — working prototype.** Backend 81 pytest + frontend 9 node --test all green;
ruff + mypy --strict clean; frontend builds; live browser run verified (setpoint clamp, RF on/off,
recording, WS telemetry, plot). Simulator-first, safety-first, mirrors FLIR.

Next candidates (not started): (a) read-only hardware probe on the real unit to confirm the CXN
dialect; (b) local match-tracking loop; (c) wire the advisory thermal loop to FLIR + accepted-power
control after true-power commissioning; (d) `git init` + initial commit.
