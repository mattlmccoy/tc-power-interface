# CXN-Panel-Inspired Main-Page Redesign — Design Spec

**Goal:** Reorganize the operator dashboard around the controls that matter most for real runs
(the matching network), demote the experimental closed loop, and pull the useful ideas from the
original T&C "CXN Panel" vendor software (analog gauges, numeric+spinner cap entry, status LEDs,
VDC/Preset/RF-source/Leveling).

**Reference:** the original CXN Panel (screen capture `rf_0613_15wtpct_t2_05062025.mp4`, connected
frame): four analog needle gauges (Requested/Forward/Reverse/Load power, 0–600 W, red needle +
digital readout), a prominent Load Cap % / Tune Cap % block with numeric fields + up/down spinners,
VDC and Preset, RF-source (internal/external) and Leveling (forward/load) radios, Frequency /Mode /
Internal-temperature readouts, and a status-LED column (RF ON, Forward Limit, Reverse Limit,
Overheat, Interlock, A/D Remote).

## Decisions (approved 2026-09-05)
- **Analog gauges:** OFF by default (compact digital readouts stay default); a toggle swaps in the
  four needle gauges.
- **Closed loop:** moved OFF the dashboard into a new **Experimental** tab (alongside
  Dashboard / Settings), clearly labeled untested.
- **CXN extras:** include ALL — status-LED strip, live cap-position readback, and
  VDC + Preset + RF-source + Leveling.

## Sub-projects (each ships working, tested software)

### A. Dashboard reorder + Experimental tab + gauges toggle + status LEDs (frontend-only)
- **Matching network promoted** to the top of the control column. Tune Cap and Load Cap each get:
  a numeric % field (direct entry, 0–100, clamped), **up/down fine-adjust buttons (±1%,
  hold-to-repeat)**, and the existing slider. Operates on the commanded value until readback (B)
  lands. Writable only in manual mode (unchanged safety rule).
- **Experimental tab:** new top-bar tab; the whole Thermal-control (closed loop) panel moves there,
  with an "experimental / untested" banner.
- **Analog gauges toggle:** a control that swaps the digital Telemetry readouts for four SVG needle
  gauges (Requested = setpoint, Forward, Reverse, Load). Pure SVG, theme-aware. Persist the choice
  in localStorage.
- **Status-LED strip:** RF ON, Forward Limit, Reverse Limit, Overheat, Interlock — derived from the
  already-decoded CXN status bits (`statusFlagNames`/`STATUS_FLAGS`). Green/amber/red/off.

### B. Live cap-position readback (protocol + device + simulator + UI)
- Parse the actual Tune Cap % and Load Cap % from the CXN status response into new `Telemetry`
  fields `tune_cap_percent` / `load_cap_percent` (verify the real GS field layout in
  `protocol/codec.py` before building; capture a real/simulated sample). The simulator reflects the
  last commanded positions. The matching-network panel shows the live readback next to the command.

### C. VDC + Preset + RF-source + Leveling (protocol + device + simulator + API + UI)
- Add read (VDC value; RF-source; leveling; preset) + write (select preset; set RF-source; set
  leveling) CXN commands, mirrored in the simulator, exposed via the API, and surfaced as CXN-style
  controls. Each new protocol field must be verified against `codec.py`/real captures before use
  (data-contract rule) — no invented field offsets.

## Non-negotiable safety (unchanged)
Simulator-first; RF defaults OFF; no automatic RF-enable; the protection layer still commands RF off
on any trip. Cap writes remain manual-mode-only. The closed loop still never enables RF.

## Testing
- A: frontend `node --test` for any pure helpers (gauge geometry, LED mapping, spinner clamping);
  browser verification for the layout/tab/gauges.
- B, C: backend `pytest` (codec parse/encode round-trips against captured samples, simulator
  reflection, API), frontend tests for new client methods, browser verification.
