# Software Matching Auto-Tuner — Design Spec

**Goal:** A software control loop that keeps the RF matching network tuned — trimming the tune/load
caps to minimize **reflected power** as the load impedance drifts during sintering — using our
measured knowledge of how the caps affect the match. It replaces the generator's built-in auto-tuner
(which is forbidden), runs only in manual tuner mode, makes small bounded cap moves, and never
enables RF.

## Grounding facts (measured / stated — the data contract)
Bench NanoVNA S11 at 13.56 MHz (`experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-09-03_FULLCAP`
and `2026-09-04_FULLCAP_2windings`; see the `matching-network-model` memory):
- **TUNE is hyper-sensitive** — a ~0.01 move (control scale below) swings return loss ~20+ dB; the
  match is a NARROW well in tune. **LOAD is broad/forgiving.**
- **The response SHAPE (tune-sharp / load-broad) is consistent across hardware; the ABSOLUTE optimum
  (T,L) is NOT** (rewinding moved it from ~T1.44/L1.33 to ~T1.85/L2.46). ⇒ the tuner must be
  **relative** — chase the local reflected-power minimum, never a hardcoded position.
- **Direct, no network ⇒ 68% reflected.** The network matters.
- **Control units:** tune ≈ 0.12–4.92, load ≈ 0.11–4.93 (a ~0–5 scale).
- **NO in-situ VNA** — the VNA cannot be in-circuit with the RF generator, so there is no S11 during a
  run. The ONLY in-run feedback is the generator's **reflected power** (`reverse_w`). ⇒ the loop is
  **perturb-and-observe on reflected power**, model-informed (not phase-directed).
- **HARD SAFETY:** never engage the generator's built-in auto-tuner (`builtin-autotuner-forbidden`);
  drift can't be VNA-calibrated in-run.

## Approach: model-informed perturb-and-observe
Because we have magnitude only (no phase), the loop resolves direction by **dithering**: nudge a cap
a small step, read the change in reflected power, keep the move if it improved. System knowledge
makes it fast and safe rather than blind:
- **Both caps are needed together — this is a 2-D coordinated search, not tune-then-load.** In
  practice T and L are trimmed *at the same time* to reach the perfect match: **tune (T) makes the
  larger swings (coarse capture), load (L) finely trims in closer** — neither alone reaches the
  minimum. So each iteration estimates the local gradient in **both** caps and steps in both, with a
  **large/coarse step scale on T and a small/fine step scale on L** (reflecting their sensitivities),
  rather than optimizing one axis to completion before the other.
- **Feed-forward (later):** as reflected power creeps up monotonically during sinter, bias the search
  in the direction the optimum has been walking, so the loop anticipates instead of only reacting.
  (Starts as a placeholder — no VNA drift calibration is possible.)

## Sub-projects (each ships working, tested software)

### S1 — Manual-mode lock + power-on-order guidance (safety first, small)
Disabling "Manual tune mode" hands the caps to the forbidden built-in auto-tuner. Lock manual mode
**on** by default; make turning it off an explicit, hard-confirmed action with a damage warning; never
clear it automatically. Backend refuses/annotates; UI shows the warning.

Also surface the **power-on order** (see the `rf-startup-sequence` memory): the **generator must be
on BEFORE the matching network (AIT)** — AIT-first shifts the caps and ruins the tune. When the UI is
opened **disconnected**, show this order (and ideally the full per-run checklist) so no one powers the
AIT before the generator.

### S2 — Finer cap resolution + 0–5 units (prerequisite for tune precision)
Tune needs ~0.01/5 ≈ **0.2%** resolution; today's `set_tune_capacity(percent:int)` + ±1% steppers are
far too coarse. Move cap commands to a **finer resolution** (float percent, or a 0–1000 counts
command if the CXN supports it — verify in `protocol/codec.py` first, no invented command), expose the
physical **0–5 value** in the UI next to %, and make the tune stepper default to a fine step.

### S3 — Simulator reflection model (makes reflected power respond to caps)
Today the sim's reflected fraction is a fixed 1% ignoring the caps. Add a **relative** model:
`reflected_fraction = f(tune - T_opt, load - L_opt)` — a **sharp-in-tune, broad-in-load** well
(e.g. Gaussian/quadratic with a much larger tune curvature than load), floored at a small minimum,
with `(T_opt, L_opt)` a movable optimum that **drifts** slowly (optionally coupled to accumulated RF
energy) to emulate sintering. Fit the well's relative shape to the bench S1P sensitivities. This is
where the measured model is encoded; it is explicitly a demonstration model, calibrated in shape not
absolute position.

### S4 — MatchTuner control loop + API + UI
Mirror the thermal loop's architecture (`control/thermal_loop.py` is the template):
- `control/match_tuner.py` — a pure step law + a `MatchTuner` controller: `tick(dt)` reads reflected
  power from telemetry, runs the dither/step logic, and drives `set_tune_capacity`/`set_load_capacity`
  only when armed. `arm/disarm/start/stop`, `mode` (advisory/auto), `snapshot()`.
- Safety invariants (tested): never calls `enable_rf`; only drives while `manual_mode && rf_on &&
  armed`; every commanded cap stays within `[min,max]`; step size bounded; **backs off / holds** if
  reflected rises past a guard or fails to improve for N ticks; disarms on fault or RF-off; the
  protection over-reflection trip still fires independently.
- API: `GET/PUT /api/match-tuner/config` (bounds, step sizes, guard), `start/stop/arm/disarm`; a
  `match_tuner` block in the status snapshot.
- UI: a **Match tuner** panel (its home is the matching-network area) — start/stop, advisory/auto,
  arm (enabled only while RF on + manual), live readout (reflected trend, last move, hold/searching),
  and it logs its moves to `telemetry.csv` alongside the cap readback.

## Non-negotiable safety (unchanged)
Simulator-first; RF defaults OFF; no automatic RF-enable; protection commands RF off on any trip;
manual-mode-locked; the built-in auto-tuner is never engaged; real-hardware use is arm-gated and
operator-watched (the real unit's CXN support is unconfirmed — `cxn-protocol-unverified-on-real-unit`).

## Testing
- S2/S3/S4 backend: `pytest` — codec resolution round-trips (against captured/verified encodings), the
  sim reflection well (sharp-tune/broad-load/drift), and the tuner control law (converges to the well
  minimum on the sim; tune-primary; never exceeds bounds; holds/bails on non-improvement; never
  enables RF; disarms on fault).
- Frontend: `node --test` for new client methods + any pure helpers; browser verification for the
  panel.
- One sim end-to-end: start with a detuned cap pair, watch reflected power fall to the floor, then
  drift the optimum and watch it re-converge; trip protection and confirm it disarms.

## Open items to resolve during S2/S3
- The exact `%↔0–5` cap mapping and whether the CXN command supports sub-1% resolution (verify in
  codec / against the unit read-only).
- The drift model's rate/coupling — placeholder until there's a physics basis or observed-reflected
  evidence from a real run.
