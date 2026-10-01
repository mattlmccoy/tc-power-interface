# Match-map capture (b) and in-run match aid (c): implementation plan

2026-09-30. Background: `experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-09-30_COLD_MATCH_MAP_FEASIBILITY_ANALYSIS.md`.
Matt's choices (2026-09-30):
- Capture is software-driven, inside the existing VNA view.
- The in-run aid shows the map plus a "where did the match go" estimate.

**Goal:**
- (b) With the VNA session open and RF off, one button steps the caps through a grid around the
  current match, measures Gamma exactly at 13.56 MHz at each point, and fits a local map Z(T, L).
- (c) During a run, a panel shows that map, the live T/L readback, and the region where the drifted
  match must be, given the recent reflected-power readings.

The aid never moves a cap.

## Data contracts (evidence)

| Input | Evidence |
|---|---|
| Gamma at 13.56 MHz is a measured point, not interpolated | `vna-log-1790803857968.json`: `f0OffsetHz` = 0 in all 105 entries (v0.11.1) |
| Telemetry `rf_on`, `forward_w`, `reverse_w`, `tune_cap_percent`, `load_cap_percent` | `frontend/src/lib/telemetry.ts:3-17`; recorded columns in `backend/experiments/20260928_193906_RF_*/telemetry.csv` |
| Reflected-power resolution is 0.1 W | analysis section D (every reading below 1 W is a multiple of 0.1) |
| Readback flickers ±0.1 % at rest | analysis section D; `vna-log-1790803857968.json` load reads 23.5/23.6 at a fixed position |
| A command is not where the cap lands | run 193906: command 20.0 % settled at 20.8 % readback, so the map uses the READBACK |
| Reflected drifts quickly at fixed caps | run 193906: 0.1 → 3.6 W in about 20 s at T21.8/L23.6, so readings expire after 30 s |
| Telemetry cadence | run 193906: median 608 ms between rows; the tracker uses timestamps, not a fixed rate |
| Approach direction shifts Z by about 3 Ohm | analysis section A, so every captured point is approached from below on both caps |

## Design

New pure modules in `frontend/src/lib/matchmap/` (each unit-tested):
- `fit.ts`:
  - `fitMap(points)` fits Z = linear or quadratic in (dT, dL) by least squares on Re and Im.
  - It refuses fewer than 0.5 % spread on either cap. The real 09-30 tune-only log is the test case.
  - Also provides `predictZ`, `predictGamma` and `solveMatch`, plus RMS and leave-one-out RMS in Ohm.
- `plan.ts`:
  - `capturePlan(t0, l0, tuneOffsets, loadOffsets)` gives move and record steps. The last move on each
    axis before every record is upward.
  - The plan ends with a return to the start and a repeat record (drift check).
- `capture.ts`:
  - `runCapture(plan, deps)` runs the plan against injected move, wait and measure functions, with stop
    support.
  - `isStable(history, now, windowMs, deadband)` decides when the readback has settled.
- `track.ts`: `trackSample(state, sample)` turns telemetry into held-position readings:
  - Only RF on with forward power ≥ 10 W counts.
  - A position counts once it is held for ≥ 1.8 s within a 0.15 % deadband.
  - Reflected readings are treated as ±0.05 W intervals, and readings expire after 30 s.
- `locate.ts`: `locateMatch(fit, coldMatch, obs)` grids candidate live-match positions:
  - The model is the cold map shifted in (T, L).
  - It returns a consistent-cell mask, an estimate and a status: none, spot, ring, inconsistent, or
    outside.
- `store.ts`: saves and loads the active map in localStorage and validates its shape.

Wiring:
- `useVna.ts`:
  - Adds `runMapCapture(label)`, which takes the NanoVNA link exclusively like auto-tune.
  - Logs each point's sweep as phase `map`.
  - Exposes the progress and the fitted map.
- `VnaTuneView.tsx` gets a "Match map" section: label, Capture or Stop, progress, fit summary, and
  Save map JSON.
- `hooks/useMatchAid.ts` runs at App level, so readings survive tab switches. It feeds telemetry into
  `trackSample` and runs `locateMatch`.
- `components/MatchAidPanel.tsx` and `MatchMapPlot.tsx` (SVG) appear on the Dashboard and Closed-loop
  pages:
  - The plot shows cold return-loss bands, the consistent region, the estimate, the live marker and
    the readings.
  - The panel shows the guidance text, the safety caveat, and Load map file.
- `package.json` goes to 0.12.0 (MINOR).

Safety:
- The aid has no cap controls, and capture is refused while RF is on or the generator isn't armed.
  The backend interlock also refuses `enable_rf` during a VNA session.
- The panel states that rising reflection together with rising core or transformer temperature
  means turning RF off, not retuning (09-24 lesson; the 09-25 interlock spec still governs).

## Tasks (red, green and commit each)

1. `fit.ts`:
   - Synthetic linear and quadratic recovery, a degenerate-spread refusal, and LOO on the real 09-03
     2-D fixture (held-out COOR points within 3 Ohm).
   - A real 09-30 tune-only fixture that must be refused.
2. `plan.ts`: record count, an upward final approach before every record, clamping to 0..100, and a
   return plus repeat record.
3. `capture.ts`: `isStable` cases, and `runCapture` with fakes (order, stop mid-way, measure errors
   propagate).
4. `track.ts`: synthetic cases, plus a real slice of run 193906 (two readings: T21.8 rising to about
   0.19, and T20.8 at about 0).
5. `locate.ts`: one reading gives ring; two to three readings from a known shift give spot within 0.2 %
   tune; readings fitting no shift give inconsistent.
6. `store.ts`: round trip, plus junk and wrong-version rejection.
7. Wiring: useVna capture, the VNA view section, useMatchAid, the panel and plot, and the pages.
   These are UI, not unit-testable. Gates: `tsc`, `npm test`, `vite build`, and a browser render
   check with a fake map in localStorage in the in-app pane against the vite dev server (no hardware).
8. Version bump to 0.12.0. Merge `--ff-only` to main locally. Do not push or deploy without Matt's OK.
