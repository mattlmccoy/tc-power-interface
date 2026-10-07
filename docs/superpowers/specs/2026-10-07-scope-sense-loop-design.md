# Scope sense-loop logging — design

**Date:** 2026-10-07 · **Branch:** `feat/scope-sense-loop` (off `main` @ b94a4f9) · **Status:** design, awaiting review

## Goal

Read the transformer sense loop live from the Siglent SDS1202X-E (PHA0150 HV probe) inside TC-POWER,
compute the same quantities the 10-06 analysis computed by hand, and **automatically assign each reading
to the settled generator power level** — replacing the manual `scope_loop/core2_ramp/<N>W/` folder sort
and the after-the-fact plateau matching in `ramp_core2_fit.py`.

Non-goals (v1): gapless streaming (hardware cannot; see Acquisition), using the scope as an RF trip
(warn-only, decided 2026-10-07), reading the setpoint back from the generator (protocol unconfirmed).

## Evidence base (data contract)

| Fact | Source |
|---|---|
| Scope CSV layout, 1400 pts @ 1 ns, header keys (`Vertical Scale`, `Vertical Offset`, …), FW 1.3.27 | `experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-10-06_sense-loop-double/scope_loop/core2_ramp/50W/SDS00006.csv` |
| Fit method: 13.50–13.62 MHz grid (121), LSQ sin/cos/DC, Vrms = amp/√2, residual = std, H2/H3 via 3-harmonic LSQ | `2026-10-06_sense-loop-double/ramp_core2_fit.py` |
| Telemetry columns incl. `forward_w`, `reverse_w`, `tune_cap_percent` | `recording/recorder.py:31-57`; real `POWERSWEEP_core2_probe_..._telemetry.csv` |
| Setpoint is **write-only**; no readback in telemetry/snapshot | `control/controller.py:410-416`, `device/cxn.py:100`, `docs/protocol.md:67` |
| A_e = 1.58e-4 m² per core (Fair-Rite 5967003801, Mat. 67) | `2026-09-24_MATERIAL67_..._RECORD.md:26` |
| One-core loop B[mT] = 0.1051·V_rms; two-core 0.0526·V_rms; 6 mT stop = 57 / 114 V rms | record:946-951 (re-derived: 0.10505) |
| 50X vs 500X agree within 3 % at 10.5 W | record:1830 |
| PHA0150 derates to ~75 V rms at 13.56 MHz | `2026-10-06_MEETING_SUMMARY/MEETING_SUMMARY_2026-10-06.md` |
| 0.564 / 0.555 mT/√W are stale (old 2-core loop, other network state); 10-06 core 2 ≈ 0.80→0.75 mT/√W, drifts with heating | FGM session reply 2026-10-07; record:1780 |
| Poor clip seating reads LOW | record ~1148 |

**Unverified (must be checked on hardware before trusting):** `WF? DAT2` block format and the
`code·VDIV/25 − OFST` scaling on FW 1.3.27; `ATTN?` reply format; achievable read rate over USB.
The first hardware task captures real replies as fixtures (see Testing).

## Acquisition

One VISA resource string (setting): `USB0::0xF4EC::…::INSTR` today, `TCPIP0::<ip>::INSTR` later.
Backend: `pyvisa` + `pyvisa-py` (+ `pyusb` for USB; libusb required on macOS/Windows — on Windows
NI-VISA is the fallback if the libusb driver is a problem).

Per cycle (target 1–3 Hz, measured on hardware): `CHDR OFF`; `C<n>:ATTN?`, `C<n>:VDIV?`, `C<n>:OFST?`,
`SARA?`, `WFSU SP,0,NP,1400,FP,0`; `C<n>:WF? DAT2`. Scope stays in its own running/auto trigger mode;
TC-POWER never changes timebase, V/div, or trigger.

## Units

| Module | Purpose | Pure? |
|---|---|---|
| `integration/scope_codec.py` | parse `#9` block → int8 codes; scale to volts; time axis; clip detect (code at ADC rail) | yes |
| `analysis/sense_loop_fit.py` | port of `ramp_core2_fit.fit`: Vrms, f0, residual, pk min/max, H2, H3 | yes |
| `analysis/flux.py` | B_pk[mT] = 1000·Vrms / (4.443·f0·N·n_cores·A_e); limit checks | yes |
| `control/level_tracker.py` | (last commanded setpoint, forward_w, t) → `level_w` or `unassigned` | yes |
| `integration/scope_link.py` | VISA client + poll thread; stamps each reading with latest snapshot; never raises into the controller | IO |
| `recording/scope_recorder.py` | `scope.csv`, `scope_levels.csv`, `scope_waveforms/` inside the active run dir | IO |
| `api/scope_routes.py` | `APIRouter`: connect/disconnect/status/settings; readings on `/ws/telemetry` under `scope` | IO |
| `frontend/src/lib/scope.ts` + `components/SenseLoopPanel.tsx` | panel state/formatting (pure, tested) + view | — |

`api/app.py` is already 1114 lines; new routes go in their own router, not into `app.py`.
The controller gets one small addition: remember `last_setpoint_w` + its timestamp in `set_setpoint`
and expose it in `snapshot()` (needed by the level tracker; also useful in `telemetry.csv`).

## Level assignment (decided: commanded setpoint, settled only)

A reading gets `level_w = S` when: a setpoint S was commanded by TC-POWER this session, RF is on, and
`|forward_w − S| ≤ tol_w` has held continuously for `≥ settle_s`. Defaults `tol_w = 1.0`, `settle_s = 3`,
both settings. (Changed from 0.5 W during planning: real 10-06 telemetry reads +0.4…+0.6 W above the
nominal step — 5.5, 10.5 … 90.4–90.6 W in `POWERSWEEP_core2_probe_..._telemetry.csv` — so 0.5 W would
reject most 80/90 W rows.) Otherwise `level_w` is blank and `level_state` says why: `no_setpoint`, `settling`,
`off_setpoint` (e.g. front-panel change), `rf_off`. Unassigned readings are still logged, never forced
into a level.

## Outputs (only while a recording is active)

- `scope.csv` — one row per reading: `host_timestamp_ns, level_w, level_state, setpoint_w, forward_w,
  reverse_w, tune_cap_percent, load_cap_percent, vrms_v, f0_hz, resid_v, vmin_v, vmax_v, h2_pct, h3_pct,
  b_pk_mt, attn, vdiv, ofst, sara, clipped, valid, flags`.
- `scope_levels.csv` — written at finalize: per level, n valid, median Vrms, IQR, median f0, H2/H3,
  V/√W, B_pk mT. Plus one session fit of mT/√W using levels ≥ 10 W only (meter ±20 % below ~10 W).
- `scope_waveforms/<level>W.csv` — first valid settled capture per level, in the scope's own CSV
  layout (so existing scripts read it unchanged).
- Manifest lists these files with hashes, as for `telemetry.csv`.

## Flux settings (no baked-in calibration)

Settings: `turns N = 1`, `cores_linked = 1`, `A_e per core = 1.58e-4 m²`, `core label = "core 2"`,
`probe range = 50X/500X`. B is computed from volts every reading; no mT/√W constant is stored.
If `ATTN?` ≠ the selected probe range, the panel shows a mismatch warning and readings are flagged.
B is **peak, cross-section average**; the toroid inner edge runs ~1.3× higher (shown as a note only).
Stated uncertainty on B: ~±5 % (lead resonant rise ~4 %, air term).

## Flags (warn-only, decided 2026-10-07)

Loud pop-up alert + `events.json` entry + `flags` column. RF is never touched.

| Flag | Default (editable) | Settledness |
|---|---|---|
| `probe_warn` / `probe_hard` | Vrms ≥ 65 / ≥ 70 V | operating practice (PHA0150 ~75 V limit) |
| `flux_stop` | B_pk ≥ 6 mT (57 V one-core) | record's interlock value; conservative — core 2 saw 7.2 mT ×48 s with no damage on 10-06 |
| `clipped` | any int8 code at −128 or 127 (rail values unverified; confirm at hardware gate) | hard: reading marked invalid, excluded from summaries |
| `seating` | resid or H2/H3 > 3× session baseline median at same level | heuristic for low-reading clips |
| `detune` | V/√W falls > 5 % over 30 s at a constant settled level | heuristic (AIT walk-off at 90 W, 10-06) |

## Failure behaviour

Scope absent/stalled/erroring → `scope.status = "no data"` with the error text and age; values `null`,
never `0`. The poll thread catches VISA errors, backs off, and reconnects; it never blocks the
controller's IO lock (separate device). A scope failure never affects RF control or protection.

## Testing (red-green TDD)

- Codec, fit, flux, level tracker: pure unit tests. Fit fixtures **captured from real** 10-06 CSVs;
  expected Vrms/f0/H2/H3 come from running `ramp_core2_fit.py`'s `fit()` on the same files.
- Level tracker fixtures from the real `POWERSWEEP_core2_probe_..._telemetry.csv` plateaus.
- `scope_link` against a fake VISA resource; recorder against a tmp dir.
- `scope.ts` via `node --test`; `tsc --noEmit`; `vite build`.
- **Hardware gate before "done":** connect over USB, capture real `ATTN?/VDIV?/OFST?/SARA?/WF?`
  replies as fixtures, confirm the volts agree with an on-screen capture saved the old way, and measure
  read rate. Codec fixtures until then are marked shape-only.
- Existing suite stays green; `ruff`, `mypy --strict`.
