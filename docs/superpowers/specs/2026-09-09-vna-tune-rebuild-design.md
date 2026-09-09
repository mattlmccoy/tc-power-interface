# VNA Tune Rebuild — Design Spec

Date: 2026-09-09. Status: approved to build (Matt: "go ahead. build when done").

Second-pass rebuild of the pre-run VNA auto-tune after live bench feedback. Supersedes the display +
control-law parts of [[vna-autotune-shipped]] (the backend RF interlock and the vendored lib stay).
The v1 feature was "not pulling its weight": the auto-tuner couldn't recover a 3% detune, the sweep was
too narrow and static, connecting the VNA from a bespoke card mis-fired the CXN handshake, and a layout
bug ate the screen. This spec fixes all five.

## Grounding facts (verified 2026-09-09)

- **Layout root cause.** `.app { display:grid; grid-template-rows: var(--topbar-h) auto 1fr }`
  (`frontend/src/styles.css:15`). The closed-loop merge inserted `<SafetyRail/>` as a new in-flow child,
  so the child order is header(row1) / SafetyRail(row2) / Banners(row3=**1fr**) / content(row4 implicit).
  When a session is active the persistent VNA `banner.fault` becomes a grid item and **stretches to fill
  the `1fr` row** (the maroon band), shoving the tune view to the bottom. `StartupModal`
  (`.modal-overlay position:fixed`) and the connect popover (`position:absolute`) are out of flow.
- **Discovery payload.** `GET /api/discovery` (`backend/tc_power_interface/api/app.py:502`) returns
  `{device, description, hwid}` per port; `hwid` carries `USB VID:PID=0483:5740` for a NanoVNA-H4, and
  `description` reads `NanoVNA-H4`. The frontend `SerialPort` type (`frontend/src/lib/api.ts:30`) has
  `device, description` — needs `hwid` added.
- **Clicking Connect on the NanoVNA row today** runs the pyserial CXN attach → the generator handshake
  reads `C` and errors `unexpected acknowledgement byte b'C'`. The NanoVNA must instead go through the
  browser Web-Serial path (`NanoVNAConnection.connect()` → `navigator.serial.requestPort()`,
  `frontend/src/lib/vna/nanovna.ts:164`), which is what `useVna.connect()` already calls.
- **Cap-drive is independent of RF.** Caps are commanded through the generator's serial link, not the
  N-type RF coax. So with the N-type on the VNA, the generator may be connected + **armed for caps** with
  RF interlocked off (enable_rf → 409, [[vna-autotune-shipped]]).
- **Why v1's law failed (Matt's data).** From a real match, a **+3% Tune** perturbation was
  unrecoverable by the 1-D "align dip with T, then R→50 with L" loop. The network is **coupled**: both
  caps move both the resonant frequency and the coupling, so the match is a **diagonal valley** in
  (T,L). 1-D steps ping-pong across the valley. Matt matches by moving **T and L together**.

## Decisions (Matt, 2026-09-09)

1. **Algorithm = 2-D Newton on the complex error** (Z(13.56)→50+j0) with a **pattern-search fallback**.
2. **Live = continuous re-sweep, refresh as fast as the NanoVNA allows**; range **12–18 MHz**, normal
   point count. (Not a fine 4 kHz grid — 4 kHz was refresh cadence, not resolution.)
3. Connect the NanoVNA **from the connect popover**, not a bespoke card.
4. The reclaimed top band holds a **live S11 return-loss plot**.

## Workstreams (build order; each ships verifiable)

### W1 — Layout fix (small, first)
Wrap `<SafetyRail/>` + `<Banners/>` in one `<div className="app-chrome">` in `App.tsx`, so the grid is
header(row1) / chrome(row2 auto) / content(row3 **1fr**) — stable whether or not a banner renders.
`.app-chrome {}` needs no special style (block children stack). Verify: VNA mode no longer shows the
maroon band; dashboard + closed-loop + settings still lay out correctly (browser).

### W2 — 2-D auto-tuner (core; pure + TDD)
- `frontend/src/lib/vna/network_model.ts` (+ test) — a synthetic **S11(f; T, L)** for a
  series-cap / shunt-cap L-match into a complex load, with realistic **coupling** (both caps shift the
  resonance *and* the coupling). Pure; used only to test the optimizer. Not shipped to hardware.
- `frontend/src/lib/vna/autotune2d.ts` (+ test) — pure steps:
  - `estimateJacobian(z0, zT, zL, dT, dL) → [[dR/dT, dR/dL],[dX/dT, dX/dL]]` (finite difference).
  - `newtonStep(J, z0, {targetR:50, targetX:0, maxStep, clampCap}) → {dT, dL}` — solve the 2×2
    `J·[dT,dL]ᵀ = [50−R0, −X0]`, damp to `maxStep`, bound via `clampCap`, quantize to whole %.
    Ill-conditioned (|det J| < eps) → return `null` so the loop uses the fallback.
  - `patternSearchStep(measureAt, caps, step) → {tune, load, cost}` — evaluate the (T,L) neighbours
    (±step on each axis + diagonals) already sampled / cheaply sampled, pick the lowest |Γ|.
  - `converged(point)` reused from `autotune.ts` (RL < −20 dB or VSWR < 1.2).
- **Regression test (Matt's case):** on the synthetic model, from the optimum, perturb Tune +3% → the
  Newton loop drives |Γ| back under the gate within N iterations (and a pure 1-D sequential baseline is
  shown to stall, documenting why). Also: a diagonal-start recovery.
- The orchestration loop lives in `useVna` (I/O): measure → (probe T, probe L) → `newtonStep` (or
  fallback) → drive both caps (backlash-comp) → re-measure; guards: bounded caps, max iters, divergence
  abort, halts if not armed / RF on / disarmed. Never enables RF.

### W3 — Wide, live, continuous sweep
In `useVna`: sweep **12e6–18e6**, ~201 points; a cancellable **live loop** re-sweeps continuously while
connected, updating `sweep` (→ Smith + readout + S11 plot refresh live). Auto-tune **pauses** the live
loop for its measure→move→measure cycle, then resumes. Manual cap turns are visible live (the core
usability win).

### W4 — S11 return-loss plot
- `frontend/src/lib/vna/s11plot.ts` (+ test) — pure `s11PlotPoints(sweep, {width,height,dbMin,dbMax}) →
  {points, markerX}` mapping `db(s11)` vs frequency across the sweep, with the 13.56 marker x.
- `frontend/src/components/VnaS11Plot.tsx` — SVG: axes (12 / 13.56 / 18 MHz, 0…−40 dB), the live
  return-loss polyline, the 13.56 marker line. Rendered full-width in the reclaimed top band of
  `VnaTuneView`.

### W5 — Connection integration
- Backend: `SerialPort`/discovery already return `hwid`; add `hwid` to the frontend `SerialPort` type.
- `ConnectBar.tsx`: for a port where `description`/`hwid` matches a NanoVNA (`/nanovna/i` or
  `0483:5740`), render **Connect (VNA)** which calls `vna.connect()` (Web Serial) instead of
  `connectPort()` (pyserial CXN). Thread `vna` into `ConnectBar` from `App`.
- Delete the dashboard entry card (`components/VnaPanel.tsx` + its mount in `DashboardPage`); connection
  now lives only in the popover. `VnaTuneView` stays the focused UI (W1–W4 land in it).
- Keep the auto-takeover (session active ⇒ `VnaTuneView`) and the interlock unchanged.

## Non-negotiable safety (unchanged)
Never enables RF; the backend interlock refuses `enable_rf` (409) while a VNA session is active;
E-STOP / RF-OFF always available; the generator ATUNE stays forbidden; `control/match_tuner.py`
(in-run reflected-power tuner) untouched.

## Testing / verification
- `node --test`: `network_model`, `autotune2d` (incl. the +3% Tune recovery regression and the 1-D
  stall baseline), `s11plot` geometry — red→green.
- Build (`tsc + vite`) + browser: layout fix across all pages, live sweep loop, S11 plot render, the
  connect-popover VNA route (no CXN error), the takeover.
- **Real-bench gate (Matt):** the 2-D tuner recovering a real 3% detune on the NanoVNA + AIT, RF off —
  the acceptance test. Ship deployed (main ff + dist rebuild, no restart) for Matt to run.

## Open items
- Sweep point count vs refresh speed — pick ~201, tune after a live look.
- Newton `maxStep` / probe `δ` / damping — seed conservative (δ≈1–2%, maxStep≈small), tune on the bench.
- Pattern-search neighbourhood + when to prefer it over Newton — start: fallback only when det J ~ 0 or
  a Newton step raises cost twice running.
