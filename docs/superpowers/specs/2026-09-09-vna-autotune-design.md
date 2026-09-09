# VNA Auto-Tune Mode — Design Spec

Date: 2026-09-09. Status: approved to build (Matt, 2026-09-09: "build for now and I'll test later").

A **second, pre-run tuner** for the matching network, distinct from the existing in-run
reflected-power tuner. It reads live S11 from a NanoVNA (RF **off**) and drives the tune/load caps
to put Γ at 13.56 MHz at the Smith-chart centre (Z → 50 + j0) — a fast, precise coarse match from
scratch before a fire. It **de-risks** the in-run reflected-power tuner by letting the run start
already coarsely matched, so that tracker never arms cold into a bad match.

The two tuners are **mutually exclusive by RF state** (VNA ⇒ RF off; reflected-power ⇒ RF on), which
is the safety-interlock boundary. The in-run tuner ([[match-autotuner-behavior]],
`control/match_tuner.py`) is **untouched** by this work.

## Grounding facts (verified 2026-09-09 — the data contract)

- **RF-enable chokepoint.** `Controller.enable_rf()` (`backend/tc_power_interface/control/controller.py:274`)
  is the single RF-on path: `_require_armed()` → refuse if FAULT → refuse if not CONNECTED →
  `device.set_rf(True)`. The route `POST /api/rf/enable` (`backend/tc_power_interface/api/app.py:837`)
  already maps any `RuntimeError` → **HTTP 409** with the message. `disable_rf()` / `estop()` /
  `disarm()` are separate methods — RF-off and E-STOP are unconditionally allowed by construction.
- **Cap-drive path** is REST, frontend-orchestrated: `api.tune(%)` → `POST /api/match/tune`,
  `api.load(%)` → `POST /api/match/load` (`frontend/src/lib/api.ts:114`). Caps are commanded through
  the generator serial, **independent of firing RF** — so a VNA tuner drives caps with the generator
  connected + armed + RF **off**.
- **Cap helpers already exist in TC-POWER** (`frontend/src/lib/instrument.ts`): `clampCap`
  (whole-percent 0–100), `approachFromBelow`/`capSettled` (backlash-comp two-step Set),
  `capVolts`/`capPercentForVolts`, `TUNE_CAL`/`LOAD_CAL`. The control-law actuation reuses these.
- **Cap resolution is 1% whole-percent** with mechanical backlash ([[matching-network-model]]); the
  sharp tune well needs tiny steps. The model SHAPE (tune-sharp / load-broad) is consistent; the
  absolute optimum (T, L) is **not** — the law must be relative, never hardcode cap positions.
- **nanovna-web** (`github.com/mattlmccoy/nanovna-web`) is **MIT, © Matthew McCoy**; its `NOTICE.md`
  confirms it contains **no** GPL NanoVNA-Saver source. Vendoring its pure modules is license-clean.
  Pinned commit for this work: `ded36f3527645561a0f2055fbef93e051eb6db5d` (2026-08-27).
  Verified API: `rf.ts` (`magnitude`, `vswr`, `impedance(s11,50)`, `reflectedPowerPercent`,
  `nearestPointByFrequency`, `markerIndex`, `db`); `nanovna.ts` `NanoVNAConnection`
  (`static supported()`, `connect()`, `sweep(start,stop,points,segments=1,averages=1,…)→{points}`,
  `disconnect()`), browser-only (navigator.serial → Chrome/Edge).
- **Real S11 fixtures exist** (do NOT invent S11): Touchstone `.s1p`, header `# Hz S RI R 50`, e.g.
  `experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-09-03_FULLCAP/FULL_100ser_200sh_direct_8020MIX_fullcylinder_nanovna-sweep-1788456737951.s1p`
  (401 pts, 10–18 MHz, 20 kHz grid → 13.56 MHz is an exact grid point, value there ≈ detuned).
  The folder also holds near-optimum sweeps (memory: optimum ≈ T1.44/L1.33, RL ~50 dB). These live in
  the research tree, **not** in this repo — two representative sweeps get copied into the repo as
  fixtures (below).
- **App.tsx is the 2016-line monolith on `main`**; the closed-loop refactor (App.tsx → 94 +
  hooks/pages/components) is on another branch, not merged here. Keep VNA logic in pure `lib/` + one
  self-contained component so either App.tsx can host it (the seam with the closed-loop workstream,
  [[closed-loop-page-workstream]]).

## Decisions (brainstorm 2026-09-09, Matt)

1. **Integration = Option A.** Chrome frontend owns the NanoVNA (Web Serial) and runs the control law
   in TS; it **declares a session** to the operator. Frontend-only (no backend restart for the law),
   reuses vendored TS + `instrument.ts`. The interlock is a **software backstop**; the **primary**
   control is the physical coax swap (shared coax; attaching the VNA unplugs the generator feed —
   inherently exclusive; software cannot sense the coax), see [[rf-startup-sequence]].
2. **Session start = auto-begin on NanoVNA connect**, close only on explicit End (which also
   disconnects the VNA). A connected VNA ⇒ RF locked, the closest software proxy for "VNA in play."
3. **Control law = informed sequential decomposition** (not 2-D Jacobian/Newton). Tune drives the
   observable dip frequency onto 13.56 (X → 0); load drives R(13.56) → 50. A 2-D polish step is a
   future option once proven.
4. **Code reuse = vendor** `rf.ts` + `nanovna.ts` (+ their tests) into `frontend/src/lib/vna/`.

## The safety interlock (build and verify FIRST)

While a VNA session is active, `enable_rf` must be **refused**; it must **fail safe** when session
state is uncertain. Semantics:

- `enable_rf()` gains a **first** check: `_vna_session.active` → `raise RuntimeError("VNA mode — RF disabled")`
  → existing handler returns **409**.
- **begin** (`begin_vna_session`): set active, then best-effort `disable_rf()` (defense in depth;
  wrapped so it is ignored when no device is attached).
- **end** (`end_vna_session`): clear active. Never enables RF (arm/connected/not-faulted still gate).
- **heartbeat** (`vna_heartbeat`): records a timestamp. Staleness (`age_s > threshold`) is **reported**
  in the snapshot and surfaced in the UI but **never clears** the session — only explicit End does.
- **E-STOP / RF-OFF never blocked.** E-STOP disarms the device (`estop()`), so the auto-tune loop's
  next cap command is refused (409, the armed-gate) and the loop halts; E-STOP does **not** end the
  VNA session (RF stays refused). The session (frontend) and the interlock (backend) are separate.
- Operator **restart** boots idle + disarmed; the in-memory session clears safely because RF is
  independently locked until reconnect + arm. Coax-swap reminder stays in the startup checklist.
- Heartbeat ~2 s; stale after ~10 s (tunable constants).

## Units (each: one job, clear interface, tested in isolation)

**Vendored, frozen — `frontend/src/lib/vna/`** (provenance header pinning the commit + MIT):
- `rf.ts` + `rf.test.ts`, `nanovna.ts` + `nanovna.test.ts` — copied verbatim; tests run under
  `node --test` unchanged.
- `fixtures/` — two real `.s1p` sweeps (one detuned, one near-optimum) copied in with a source note,
  plus `touchstone.ts` (+ test): a small `# Hz S RI R 50` → `SweepPoint[]` loader for tests.

**New pure logic — `frontend/src/lib/vna/autotune.ts` + test** (the only new algorithm):
- `planVnaStep(sweep, {tune, load}, model) → { nextTune, nextLoad, action: 'tune'|'load'|'done', cost, converged, abort?: string }`.
- `cost = magnitude(nearestPointByFrequency(sweep, 13.56e6).s11)` (→ 0; equiv. reflected% → 0, VSWR → 1).
- Tune step: move `tune` so the dip frequency (`markerIndex`) → 13.56, using a known sign
  (`model.tuneSign`); if a step raises cost, flip the assumed sign (self-correcting), bounded attempts.
- Load step: move `load` so `impedance(…,50).re` (R at 13.56) → 50, using `model.loadSign`.
- Convergence gate: RL < −20 dB **or** VSWR < 1.2. Guards: `clampCap` bounds, `maxIterations`,
  divergence abort (cost rises N steps running), no-progress abort. Never engages the generator ATUNE
  ([[builtin-autotuner-forbidden]] — not constructible in the stack anyway).

**New UI + orchestration — `frontend/src/components/VnaPanel.tsx`** (self-contained; the seam):
- Connect NanoVNA (Web Serial) → auto-begins the session. Web-Serial-unsupported browser → "use
  Chrome/Edge", no session.
- Live readout at 13.56: `|Γ|`, R + jX, VSWR, RL dB + a compact Smith/marker view (reuses `rf.ts`).
- Auto-tune Run/Stop loop: `sweep(13.56 ± span)` → `planVnaStep` → command caps via `api.tune`/
  `api.load` with the existing `approachFromBelow`/`waitCapSettle` two-step → re-sweep → repeat until
  converged / abort / Stop. The *decision* is pure (`autotune.ts`); the *loop* (I/O, timing) is here
  (extractable to `useVnaAutotune` if it grows). Running requires the device **armed + RF off** (caps
  are gated on armed); the loop halts immediately if the snapshot shows RF on, disarmed, or faulted,
  or if a cap write returns 409.
- Heartbeat every ~2 s; explicit End / disconnect ends the session.
- Prominent **"VNA mode — RF disabled"** banner, with a distinct "liveness lost" state when stale
  (reads the snapshot `vna_session` flags, like the safety rail).
- Default placement: Experimental area, next to the match tuner; the closed-loop page can later host
  the same `<VnaPanel>` unchanged.

**Backend interlock — the one change that needs a restart:**
- `control/controller.py`: add `_vna_session` state + `begin_vna_session`/`end_vna_session`/
  `vna_heartbeat`; the first gate in `enable_rf()`; staleness in `snapshot()`.
- `api/app.py`: `POST /api/vna-session/{begin,end,heartbeat}` (mirrors `/api/match-tuner/*`);
  snapshot gains `vna_session: { active, stale, age_s }`.
- `frontend/src/lib/api.ts` + telemetry types: `vnaBegin`/`vnaEnd`/`vnaHeartbeat` + the snapshot field.

## Sub-projects (suggested build order — each ships tested)

- **V1 — Interlock (backend, safety first).** `_vna_session` + `enable_rf` gate + routes + snapshot
  field + `api.ts` calls. Pytest the invariants. Ships behind a restart (RF off, between runs).
- **V2 — Vendor + fixtures.** Copy `rf.ts`/`nanovna.ts` (+ tests) and two `.s1p` fixtures + loader.
  `node --test` green.
- **V3 — Control law.** `autotune.ts` + tests (captured fixtures + synthetic). No hardware.
- **V4 — VNA panel.** Connect/readout/Smith view, auto-begin + heartbeat + End, banner.
- **V5 — Auto-tune run loop.** Wire V3 into V4 driving caps; Stop/abort; verify in the browser (RF
  off, generator need not be present for UI; cap-drive verified against the sim or live later).

## Non-negotiable safety (unchanged)

- Never enables RF; drives caps only. The built-in generator ATUNE stays forbidden and
  unconstructible ([[builtin-autotuner-forbidden]]). RF-OFF and E-STOP always available.
- Interlock fails safe: uncertain session state ⇒ RF refused. Stale heartbeat never re-allows RF.
- `match_tuner.py` and all existing `enable_rf` behavior (except the new first-gate) are untouched.

## Testing / verification gates

- `node --test`: vendored `rf`/`nanovna` tests; new `touchstone` + `autotune` tests (real fixtures
  **and** synthetic sweeps — capture fixtures from reality, never invent S11).
- `pytest`: interlock unit — enable_rf refused while session active (message + that the route would
  409); `disable_rf`/`estop` allowed regardless; begin forces RF off; end does not enable RF; stale
  never clears the session.
- Real-data gate (DEFERRED to before first real use, per Matt): `planVnaStep` converges toward the
  bench optimum on a captured sweep (offline, now); one live NanoVNA + generator/AIT run with RF
  **off**, confirming caps drive while the generator is armed + RF off.
- Deploy: frontend ships via `cd frontend && npm run build` (no restart); the backend interlock ships
  via `launchctl kickstart -k gui/$(id -u)/com.tcpower.operator` — coordinate with Matt, RF off,
  between runs ([[tc-power-serving-and-deploy]]).

## Open items to resolve during build

- Narrow-sweep parameters (span around 13.56, points, averages) — pick defaults in V4 and note them;
  tune for dip resolution vs sweep time.
- `model` sign defaults (`tuneSign`, `loadSign`) — seed from [[matching-network-model]] / bench data;
  the law is self-correcting if a step worsens cost, but a good seed avoids a wasted probe.
- Whether to also expose `analyzeResonance` (vendored `analysis.ts`) for a richer resonance readout —
  optional; `markerIndex` from `rf.ts` suffices for V1–V5.
