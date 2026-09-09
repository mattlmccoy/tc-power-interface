# Closed-loop operator page + Dashboard component extraction — Design

**Date:** 2026-09-08
**Status:** design (approved in brainstorming; awaiting spec review) → implementation plan
**Author:** Claude (with Matt McCoy, operator/decision-maker)

## Goal

Give the RF-sintering operator a dedicated **Closed loop** page laid out around the thermal control
loop, so a real PA12 fire can be run without flipping tabs — with **all** the Dashboard's functionality
and feedback present, customized around the loop. Getting there also fixes the 2016-line `App.tsx` by
extracting its inline panels into reusable components (Matt's approved "direction A", 2026-09-08):

> Extract the Dashboard's operator panels into reusable components (which also fixes the oversized
> App.tsx), then build a dedicated "Closed loop" page composed from the SAME components, laid out
> around the thermal control loop. "Experimental" shrinks to the genuinely experimental leftovers.

Frontend-first, safety-first, simulator-first. This tool is on a **live bench** (real AG 0613
generator; live FLIR A70; an advisory thermal loop may be running). This work **never enables RF and
never actuates hardware** — RF is Matt's at the console.

## Approved decisions (brainstorming, 2026-09-08)

1. **Hero trace = option B, with C as a toggle.** Resting hero draws the selected control ROI's
   `mean_c` (thick, live-green) vs the amber `target_c` + approach band, **plus the ROI's `max_c`
   line**. The other live ROIs (caps, powder, electrodes) are a **faint overlay toggle, OFF by
   default**.
2. **PULSE folds into Settings.** No "Experimental" tab. Tabs become `Dashboard | Closed loop |
   Settings`. The simulator-only PULSE panel moves under Settings, keeping its "simulator-only" flag.
3. **Low-risk backend data-surfacing is authorized** in TC-POWER's *own* snapshot (`control_max_c` +
   a compact per-ROI temp roster) so the hero's over-temp line and C-overlay are real. The **FLIR
   contract stays locked** (see [[flir-thermal-control-contract]]).
4. **The enforced 250 °C latched ABORT is split into its own spec/plan** (§10). It is new
   safety-critical control code and does not ride inside this UI-refactor. Its banner + enforced
   ceiling render **honestly-dormant** here (never a false "safe").
5. **The global safety rail's DISARM = device disarm** (drop to read-only). The hero keeps its own
   finer **DISARM LOOP** (stop the loop driving). E-STOP cascades both.

## Grounded data contract (verified 2026-09-08, not assumed)

Per the project data-contract rule, every external field below was read from the real code, not
inferred.

**Frontend already receives** (`Status.thermal`, [frontend/src/lib/telemetry.ts:60](../../../frontend/src/lib/telemetry.ts)):
`running, phase, mode, armed, source, control_temp_c, target_c, recommended_w, applied_w, control_roi,
available_rois`. The green **mean-vs-target** line + band + phase + all loop vitals/controls are
therefore fully supported **frontend-only** — `control_temp_c`/`target_c` are buffered client-side
like the existing forward/reflected plot (reuse the tested `TraceBuffer`, telemetry.ts:200).

**Backend has but does not surface:**
- `control_max_c` — the selected ROI's `max_c` is already computed each poll and stored as
  `FlirPollingSource.latest_max_c`
  ([backend/.../integration/flir_roi_temps.py:87,109-117](../../../backend/tc_power_interface/integration/flir_roi_temps.py));
  the loop never reads it and the snapshot never emits it.
- The `thermal` block is assembled at
  [backend/.../api/app.py:443-447](../../../backend/tc_power_interface/api/app.py) as
  `{**_thermal().snapshot(), source, control_roi, available_rois}` — extras are read off the source.
  Surfacing `control_max_c` and a roster is the **same augmentation pattern**, not a rebuild.

**Backend does NOT have (must be built — split to §10):** any abort / ceiling / latch. The only
"ceiling" in the codebase is the *power* ceiling `loop_ceiling_w`
([backend/.../control/thermal_loop.py:51,193](../../../backend/tc_power_interface/control/thermal_loop.py)).
`safety.py`'s over-temp trip is on the **generator internal temperature**, not the FLIR ROI.
The 250 °C figure comes from the 2026-09-07 trust *design* (`status: design`); Matt's standing
instruction is **do not invent the trip number** ([[flir-thermal-control-contract]]).

**Poller discards per-ROI temps today:** `poll_once` keeps only ROI *names*
([flir_roi_temps.py:108](../../../backend/tc_power_interface/integration/flir_roi_temps.py)); the
C-overlay needs each ROI's `mean_c`, so the poller must retain + expose them (§6.1).

## Architecture — how the zero-behavior extraction works

The blocker: **all state, refs, effects, and handlers live in the one `App()` closure**, and the
telemetry WebSocket must persist across page switches (today it does because it lives in `App`).

1. **`useOperator()` hook, called ONCE at the top of `App`.** Owns the WS + config-sync effects +
   every `useState`/`useRef` (`setpointRef`, `capReadRef`, `capBusy`, `waitCapSettle`, the cap
   readback mirror, …) + every handler, returning one typed `Operator` object. Called once → the WS
   stays a singleton across page switches (no reconnect, no lost `TraceBuffer` history) →
   **behavior-preserving**. Split into cohesive sub-hooks (`useTelemetrySocket`, `useConfigSync`,
   `useCapControl`, `useThermalControls`) if it exceeds the 400-line file rule; `useOperator` stitches
   them.
2. **Panels become presentational components** taking a narrowed slice of `Operator` as typed props.
   No panel owns operator state.
3. **Pages compose panels.** `App` renders `<ActivePage op={op}/>`; each page passes the same
   `Operator` slices to the same panel components. This is what makes Dashboard and Closed-loop share
   panels literally, not by copy.

## Phase 1 — pure refactor (ZERO behavior change)

Create `useOperator()`; extract every panel into a presentational component; split the three current
views into `DashboardPage` + `SettingsPage`. `App.tsx` drops to a thin shell (~80 lines).
**No new behavior, no visual change.**

**Gate (all must pass, committed separately from Phase 2):**
- `npx tsc --noEmit` clean.
- `npm test` — **46/46** still green (no test edits except import-path moves).
- `npm run build` clean.
- **Pixel A/B of the Dashboard before/after** in real Chrome (claude-in-chrome MCP against
  `http://127.0.0.1:8010`; the in-app Browser pane blocks localhost — see
  [[tc-power-serving-and-deploy]]). Dashboard must be visually identical.

## Phase 2 — the Closed-loop page

### 6.1 Backend data-surfacing (low-risk; loop behavior unchanged; TDD red-green)
- **`control_max_c`:** surface `FlirPollingSource.latest_max_c` in the `thermal` block at app.py:443
  (sim source → `null`). No new loop behavior.
- **Per-ROI roster:** retain each ROI's `mean_c` + `valid` in `poll_once`, add a
  `latest_roi_temps() -> list[{name, mean_c, valid}]` getter, surface as `thermal.roi_temps`.
- **Tests:** extend the existing `select_control_temp`/poller tests (`tests/test_flir_roi_temps.py`)
  from captured real payloads — the roster-retention + max_c-passthrough are pure and get a failing
  test first. **No invented fixtures** (captured shapes already exist per [[flir-thermal-control-contract]]).
- **Frontend types:** add optional `control_max_c?: number | null` and `roi_temps?: {...}[]` to
  `ThermalStatus` (optional → older operators degrade cleanly).

### 6.2 The page (frontend)
- **`ThermalHero`** = `ThermalTrace` (§8) + phase strip (RAMP→APPROACH→SOAK→COOL→DONE) + a
  **dormant ABORT-banner slot** (§10) + `ThermalControls` (control-temp→target, recommended→applied,
  reason, ROI selector, mode seg, Start/Stop, ARM/DISARM LOOP, plan summary + edit link to Settings).
- **`SafetyRail`** — a persistent strip under the tabs, on **every** page: **E-STOP · RF OFF ·
  DISARM (device)**, plus the connection pill and the version-handshake / fault banners dock here.
  Safe-direction actions are never behind a tab. (This is intentionally new behavior, verified in
  real Chrome; not part of the Phase-1 pixel A/B.)
- **`ClosedLoopPage`** composes `ThermalHero` (hero band) + a compact lower band reusing
  `RfPowerPanel`, `TelemetryPanel` (gauges), `HistoryPanel`, `MatchingNetworkPanel`,
  `MatchTunerPanel`, the LED strip, and a reserved **Calibration slot** (§10). Nothing on the
  Dashboard is unreachable here.
- **Tab rename** `Experimental → Closed loop`; **PULSE** panel moves into `SettingsPage`.

### 6.3 New pure logic (TDD red-green, `node --test`, in `src/lib/`)
- **`heroTrace.ts`** — series→SVG coordinate scaling; **auto-fit temp range** that always includes
  `target_c` and (when present) `control_max_c`; approach-band rectangle geometry; time-window
  mapping. Pure; tested first.
- **`thermalView.ts`** — `phase → {label, color, index}`; recommended/applied formatting; the
  **over-temp-guard presentation state** (`max_c` present → show the line; absent → an explicit
  "over-temp guard: not reported" affordance, **never a false-green**).
- Reuse the tested `TraceBuffer` for a thermal history buffer inside `useOperator`.

### 6.4 Gate
`tsc` clean, `node --test` green (new pure logic red→green), `npm test` full suite green,
`npm run build` clean, and real-Chrome verification of the page (hero renders B; C-toggle overlays;
safety rail on all pages; PULSE under Settings; every Dashboard control reachable). The hero opens in
a realistic working state (live loop data, or the simulator source).

## 7. File map (every file ≤ 400 lines)

```
src/hooks/useOperator.ts        all state/effects/handlers (split into sub-hooks if >400)
src/App.tsx                      thin shell: useOperator + <SafetyRail> + <ConnectBar> + <ActivePage>
src/pages/
  DashboardPage.tsx  SettingsPage.tsx  ClosedLoopPage.tsx
src/components/                  presentational, props-driven
  ConnectBar  Banners  SafetyRail*  Toast  StartupModal
  TelemetryPanel  RfPowerPanel  GeneratorPanel  HistoryPanel
  MatchingNetworkPanel  MatchTunerPanel  TimerPanel  RecordingPanel
  SafetyLimitsPanel  ThermalPlanPanel  LoggingPanel  FlirLinkPanel  OperatorPanel
  PulsePanel                     (rendered under Settings)
  ThermalHero* ThermalTrace* ThermalControls*
src/lib/                         new pure logic (TDD)
  heroTrace.ts*  thermalView.ts*
        (* = introduced in Phase 2)
```
Existing `components/` (`Gauge`, `StatusLeds`, `TimePlot`, `ErrorBoundary`) and `lib/` are reused
unchanged. Keep the CXN design language (analog dials, LED strip, mono readouts, the existing
palette/typography from `theme.css`); extend it, do not invent a new aesthetic.

## 8. Hero-trace visual spec (option B resting + C toggle)

- **Control ROI `mean_c`** — thick (~2.8px) `--live` green, emphasized endpoint dot. The controlled
  signal.
- **`target_c`** — `--accent` amber, dashed, labeled; **approach band** = faint amber fill of
  `± approach_band_c` around target.
- **`control_max_c`** — thin (~1.6px) `--err` red, the ROI's hottest pixel (over-temp awareness).
  Rendered only when the field is present; absent → not drawn + a small "max not reported" note.
- **Other ROIs (C toggle)** — faint `--other` grey `mean_c` lines from `thermal.roi_temps`, **off by
  default**, toggle persisted in `localStorage` (like the gauges toggle). A small legend appears when on.
- **Y-range** auto-fits to include target + max_c with headroom; chart text takes theme tokens.
- **Enforced 250 °C ceiling line** — **NOT drawn here** (would imply enforcement that does not exist);
  it belongs to §10 and appears when that sub-project lands.

## 9. Testing / verification gates

- **TDD (pure logic, red→green):** `heroTrace.ts`, `thermalView.ts` (frontend `node --test`); the
  backend roster-retention + `control_max_c` passthrough (`pytest`, from captured payloads).
- **Regression:** `npm test` 46/46 through Phase 1; backend `pytest` green after §6.1.
- **Not unit-testable (stated, not skipped):** the hero SVG rendering, the page layout, the safety
  rail, and the Dashboard pixel-equivalence are DOM/visual → verified in **real Chrome** (Phase-1 A/B;
  Phase-2 page walkthrough), never asserted without a screenshot.
- **Deploy note (LIVE bench):** frontend changes need `cd frontend && npm run build` (operator serves
  static `dist`, no restart). The §6.1 **backend** change additionally needs
  `launchctl kickstart -k gui/$(id -u)/com.tcpower.operator` — a restart that **interrupts a running
  loop**. Do NOT restart the operator without confirming timing with Matt (no advisory/auto loop
  mid-run). See [[tc-power-serving-and-deploy]].

## 10. Seams & coordination

- **Sub-project 2 — enforced max-temp abort (separate spec/plan, coordinated, Matt's trip number):**
  the 250 °C latched abort law (valid `max_c ≥ ceiling` → setpoint 0, disarm loop, latch; re-arm
  blocked while hot, per the 2026-09-07 trust spec §4). It adds `aborted`/`abort_reason`/
  `abort_temp_c`/`abort_ceiling_c` to the snapshot; the hero's dormant ABORT banner + a ceiling line
  activate off those fields. **This spec builds the dormant UI seam only** — no enforced abort, no
  invented ceiling number.
- **Calibration slot:** a labeled, reserved region lower-right in `ClosedLoopPage` for the sibling
  "RF thermal calibration print + routine" session (step tests, `calibration.json` status,
  per-session absorbed-power identification). This spec leaves the space; that session fills it.
  See [[thermal-control-design-decisions]].
- **FLIR feed:** owned by the FLIR Research Interface session; the contract is **locked** — no feed
  changes requested or needed. See [[flir-thermal-control-contract]].

## 11. Out of scope (do NOT build here)

- The enforced max-temp abort law (→ §10 sub-project 2).
- Any RF enable / hardware actuation (Matt's, at the console).
- Control-quality work (gain tuning, plant ID, feedforward) — deferred workstream.
- Multi-segment recipes / profile editor.
- FLIR-side changes.
- The 250 °C trip number (Matt provides it; never invented).

## 12. Open risks

- **Phase-1 behavior drift:** moving all state into `useOperator` risks a subtle effect/ref-identity
  change. Mitigation: single call site preserves the WS singleton; the pixel A/B + 46/46 suite is the
  gate; commit Phase 1 separately so it is bisectable.
- **`MatchingNetworkPanel` size** (the densest panel — caps ×2 + MODE + presets) may approach the
  400-line limit; split into `CapControl` + `PresetBank` sub-components if so.
- **`roi_temps` payload size / cadence** at ~10 Hz with many ROIs — keep the surfaced roster compact
  (name/mean/valid only) and the C-overlay decimated to the plot width.
- **Backend deploy on a live bench** (§9) — the only bench-risk touchpoint; gated on Matt's timing.
