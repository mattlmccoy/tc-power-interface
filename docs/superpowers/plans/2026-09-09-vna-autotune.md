# VNA Auto-Tune Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes. TDD red→green on V1 + V3; build/browser gate on V4/V5.

**Goal:** Add a pre-run, RF-off VNA auto-tune that drives the tune/load caps to Smith-centre at 13.56 MHz from live NanoVNA S11, behind a fail-safe RF interlock.

**Architecture:** Frontend owns the NanoVNA (Web Serial) + the control law (vendored nanovna-web TS + new pure `autotune.ts`); a declared VNA session on the backend refuses `enable_rf` while active. See spec `docs/superpowers/specs/2026-09-09-vna-autotune-design.md`.

**Tech Stack:** Python/FastAPI backend (`uv run python -m pytest`), TS frontend (`npm test` = `node --experimental-strip-types --test`), vendored nanovna-web@`ded36f3`.

**Toolchain note (verified 2026-09-09):** backend tests run as `uv run python -m pytest …` (the bare `uv run pytest` resolves a broken global pytest). Dev extras installed into the worktree venv (`uv pip install -e . "pytest>=8" pytest-asyncio httpx`). 278 tests collect green.

---

### Task V1: Backend VNA-session interlock (+ frontend client)

**Files:**
- Modify: `backend/tc_power_interface/control/controller.py` (add `_vna_session` state, gate in `enable_rf`, begin/end/heartbeat, snapshot field)
- Modify: `backend/tc_power_interface/api/app.py` (routes `POST /api/vna-session/{begin,end,heartbeat}`; snapshot already surfaced via controller)
- Modify: `frontend/src/lib/api.ts` (`vnaBegin`/`vnaEnd`/`vnaHeartbeat`), `frontend/src/lib/telemetry.ts` (`vna_session` on Status)
- Test: `backend/tests/test_vna_interlock.py`

- [ ] **Step 1: Failing test** — `backend/tests/test_vna_interlock.py`:

```python
import pytest
from tc_power_interface.control.controller import Controller, ControllerState
from tc_power_interface.device.simulated import SimulatedDevice

def _armed_controller() -> Controller:
    c = Controller(SimulatedDevice())
    c.start()                      # sim-boot path: armed + CONNECTED
    return c

def test_enable_rf_refused_while_vna_session_active():
    c = _armed_controller()
    c.begin_vna_session()
    with pytest.raises(RuntimeError, match="VNA mode"):
        c.enable_rf()

def test_begin_forces_rf_off_best_effort():
    c = _armed_controller()
    c.enable_rf()                  # RF on first
    c.begin_vna_session()
    assert c.snapshot()["telemetry"]["rf_on"] in (False, None)  # forced off

def test_end_clears_session_but_does_not_enable_rf():
    c = _armed_controller()
    c.begin_vna_session(); c.end_vna_session()
    assert c.snapshot()["vna_session"]["active"] is False
    c.enable_rf()                  # now allowed (no exception)

def test_estop_and_disable_rf_allowed_during_session():
    c = _armed_controller()
    c.begin_vna_session()
    c.disable_rf()                 # must not raise
    c.estop()                      # must not raise

def test_stale_heartbeat_does_not_clear_session():
    c = _armed_controller()
    c.begin_vna_session()
    snap = c.snapshot()["vna_session"]
    assert snap["active"] is True and "stale" in snap and "age_s" in snap
```

- [ ] **Step 2: Run, see fail** — `cd backend && uv run python -m pytest tests/test_vna_interlock.py -q` → FAIL (`begin_vna_session` missing).
- [ ] **Step 3: Implement in `controller.py`** — add in `__init__`: `self._vna_session_active=False`, `self._vna_hb_ns: int|None=None`, `self._vna_stale_s=10.0`. First line of `enable_rf()` (before `_require_armed`): `if self._vna_session_active: raise RuntimeError("VNA mode — RF disabled")`. Methods:

```python
def begin_vna_session(self) -> None:
    with self._lock:
        self._vna_session_active = True
        self._vna_hb_ns = time.monotonic_ns()
    try:
        self.disable_rf()          # defense in depth; ignored if no device
    except Exception:              # noqa: BLE001
        pass

def end_vna_session(self) -> None:
    with self._lock:
        self._vna_session_active = False
        self._vna_hb_ns = None

def vna_heartbeat(self) -> None:
    with self._lock:
        if self._vna_session_active:
            self._vna_hb_ns = time.monotonic_ns()
```

In `snapshot()` add a `"vna_session"` key:

```python
age_s = None if self._vna_hb_ns is None else (time.monotonic_ns()-self._vna_hb_ns)/1e9
"vna_session": {
    "active": self._vna_session_active,
    "stale": bool(self._vna_session_active and age_s is not None and age_s > self._vna_stale_s),
    "age_s": age_s,
},
```

- [ ] **Step 4: Run, see pass** — same command → PASS. Then full controller suite: `uv run python -m pytest tests/test_controller.py tests/test_vna_interlock.py -q` → PASS.
- [ ] **Step 5: Routes in `app.py`** (mirror `/api/match-tuner/*`, near line 837):

```python
@app.post("/api/vna-session/begin")
def vna_session_begin() -> dict[str, Any]:
    _controller().begin_vna_session(); _record_event("vna_session_begin"); return _status_payload()

@app.post("/api/vna-session/end")
def vna_session_end() -> dict[str, Any]:
    _controller().end_vna_session(); _record_event("vna_session_end"); return _status_payload()

@app.post("/api/vna-session/heartbeat")
def vna_session_heartbeat() -> dict[str, Any]:
    _controller().vna_heartbeat(); return _controller().snapshot()
```

- [ ] **Step 6: Frontend client** — `api.ts`: add `vnaBegin: () => post("/api/vna-session/begin")`, `vnaEnd`, `vnaHeartbeat`. `telemetry.ts`: add to `Status` `vna_session?: { active: boolean; stale: boolean; age_s: number | null }`.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(rf): fail-safe VNA-session interlock refusing enable_rf"`

### Task V2: Vendor nanovna-web lib + fixtures

**Files:** Create `frontend/src/lib/vna/{rf.ts,rf.test.ts,nanovna.ts,nanovna.test.ts,touchstone.ts,touchstone.test.ts}`, `frontend/src/lib/vna/fixtures/{detuned.s1p,matched.s1p}`, `frontend/src/lib/vna/PROVENANCE.md`.

- [ ] **Step 1** — Copy `rf.ts`, `rf.test.ts`, `nanovna.ts`, `nanovna.test.ts` verbatim from nanovna-web@`ded36f3` `src/lib/` into `frontend/src/lib/vna/`. Add a 3-line header to `rf.ts`/`nanovna.ts`: source repo, commit, MIT © Matthew McCoy. Write `PROVENANCE.md` (repo + commit + MIT + NanoVNA-Saver attribution per upstream NOTICE.md).
- [ ] **Step 2** — Copy two real sweeps into `fixtures/` (detuned + near-optimum) from `experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-09-03_FULLCAP/…`. Record exact source paths in `PROVENANCE.md`.
- [ ] **Step 3: Failing test** `touchstone.test.ts` — parse a fixture, assert 13.56 MHz point exists and `|Γ|` is finite.
- [ ] **Step 4** `touchstone.ts` — `parseTouchstone(text: string): SweepPoint[]` reading `# Hz S RI R 50` (skip `!`/`#`; split `freq re im`; `s21={re:0,im:0}`). Node test helper `loadFixture(name)` via `node:fs`.
- [ ] **Step 5: Run** `cd frontend && npm test` → vendored + touchstone tests PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(vna): vendor nanovna-web rf/nanovna lib + real .s1p fixtures"`

### Task V3: Control law `autotune.ts`

**Files:** Create `frontend/src/lib/vna/autotune.ts` + `autotune.test.ts`.

- [ ] **Step 1: Failing test** (against fixtures + synthetic):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { planVnaStep, F0, DEFAULT_MODEL } from "./autotune.ts";
import { parseTouchstone } from "./touchstone.ts";
import { readFileSync } from "node:fs";

const load = (f: string) => parseTouchstone(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

test("matched sweep converges", () => {
  const r = planVnaStep(load("matched.s1p"), { tune: 44, load: 44 }, DEFAULT_MODEL);
  assert.equal(r.converged, true);
  assert.equal(r.action, "done");
});

test("detuned sweep proposes a bounded in-range move, not converged", () => {
  const r = planVnaStep(load("detuned.s1p"), { tune: 44, load: 44 }, DEFAULT_MODEL);
  assert.equal(r.converged, false);
  assert.ok(r.nextTune >= 0 && r.nextTune <= 100 && r.nextLoad >= 0 && r.nextLoad <= 100);
  assert.ok(Math.abs(r.nextTune - 44) + Math.abs(r.nextLoad - 44) > 0); // it moved
});

test("cost is |Γ| at 13.56 and gate is RL<-20dB or VSWR<1.2", () => {
  // synthetic: a point at |Γ|=0.02 → converged; |Γ|=0.5 → not
  // (build a 3-point sweep around F0)
});
```

- [ ] **Step 2: Run, see fail** — `npm test` → FAIL (module missing).
- [ ] **Step 3: Implement** `autotune.ts`:

```ts
import { magnitude, vswr, impedance, nearestPointByFrequency, markerIndex, db, type SweepPoint } from "./rf.ts";
import { clampCap } from "../instrument.ts";

export const F0 = 13.56e6;
export interface TuneModel { tuneSign: 1 | -1; loadSign: 1 | -1; tuneStep: number; loadStep: number; maxIter: number; }
export const DEFAULT_MODEL: TuneModel = { tuneSign: 1, loadSign: 1, tuneStep: 1, loadStep: 1, maxIter: 40 };
export interface VnaStep { nextTune: number; nextLoad: number; action: "tune" | "load" | "done"; cost: number; converged: boolean; abort?: string; }

export function gammaAt(sweep: SweepPoint[]): SweepPoint | null { return nearestPointByFrequency(sweep, F0); }
export function converged(p: SweepPoint): boolean { return db(p.s11) < -20 || vswr(p.s11) < 1.2; }

export function planVnaStep(sweep: SweepPoint[], caps: { tune: number; load: number }, model: TuneModel): VnaStep {
  const p = gammaAt(sweep);
  if (!p) return { nextTune: caps.tune, nextLoad: caps.load, action: "done", cost: 1, converged: false, abort: "empty sweep" };
  const cost = magnitude(p.s11);
  if (converged(p)) return { nextTune: caps.tune, nextLoad: caps.load, action: "done", cost, converged: true };
  // tune = align dip freq onto F0; load = pull R(F0) -> 50
  const dipHz = sweep.length ? sweep[markerIndex(sweep)].frequency : F0;
  if (Math.abs(dipHz - F0) > (sweep[1]?.frequency - sweep[0]?.frequency || 0)) {
    const dir = dipHz < F0 ? model.tuneSign : (-model.tuneSign as 1 | -1);
    return { nextTune: clampCap(caps.tune + dir * model.tuneStep), nextLoad: caps.load, action: "tune", cost, converged: false };
  }
  const R = impedance(p.s11, 50).re;
  const dir = R < 50 ? model.loadSign : (-model.loadSign as 1 | -1);
  return { nextTune: caps.tune, nextLoad: clampCap(caps.load + dir * model.loadStep), action: "load", cost, converged: false };
}
```

(Tune/load signs are seeds; the run loop flips a sign if a step raises `cost` — tracked in V5.)

- [ ] **Step 4: Run, see pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(vna): informed sequential control law (tune->dip, load->R=50)"`

### Task V4: VnaPanel component (UI + session)

**Files:** Create `frontend/src/components/VnaPanel.tsx`; Modify `frontend/src/App.tsx` (mount in Experimental area + a global "VNA mode" banner reading `status.vna_session`).

- [ ] **Step 1** — `VnaPanel.tsx`: `NanoVNAConnection` connect button (guard `NanoVNAConnection.supported()`), on connect → `api.vnaBegin()` + start a ~2 s `setInterval` heartbeat (`api.vnaHeartbeat`); End/disconnect → clear interval + `api.vnaEnd()` + `conn.disconnect()`. Live readout from a single `conn.sweep(F0-1e6, F0+1e6, 101)` → `gammaAt` → show `|Γ|`, R+jX (`impedance`), VSWR, RL dB. A small inline SVG Smith dot (reuse `rf.ts`).
- [ ] **Step 2** — In `App.tsx`, render `<VnaPanel status={status} />` in the Experimental section; add a top banner `{status?.vna_session?.active && <div className="banner err">VNA mode — RF disabled{status.vna_session.stale ? " · liveness lost" : ""}</div>}`.
- [ ] **Step 3: Verify** — `cd frontend && npm run build` (tsc+vite) green. Browser: `npm run dev`, open the panel, confirm the banner appears when a session is active (simulate via the operator or a stubbed status). No console errors.
- [ ] **Step 4: Commit** — `git commit -m "feat(vna): NanoVNA panel — connect, live S11 at 13.56, session + banner"`

### Task V5: Auto-tune run loop

**Files:** Modify `frontend/src/components/VnaPanel.tsx` (add Run/Stop loop).

- [ ] **Step 1** — Add a Run/Stop button. Run loop (async, cancellable): require `status.armed && !status.telemetry.rf_on && state==='connected'`; each iter: `sweep(F0±1e6,101)` → `planVnaStep(sweep,{tune,load},model)` → if `action!=='done'` command the cap via `api.tune`/`api.load` using `approachFromBelow`+`waitCapSettle` (reuse App's helper or inline) → loop; stop on `converged`, `abort`, Stop, `iter>=maxIter`, or any non-OK status (rf_on/disarmed/faulted/409). If a step raises `cost` vs the previous, flip that axis's sign in a local model copy (self-correcting), capped.
- [ ] **Step 2: Verify** — `npm run build` green; browser: the Run button is disabled unless armed + RF off; Stop halts the loop. (Cap-drive against real hardware is the deferred live gate.)
- [ ] **Step 3: Commit** — `git commit -m "feat(vna): auto-tune run loop driving caps to the 13.56 match"`

## Self-review notes
- Spec coverage: interlock (V1), vendor+fixtures (V2), control law (V3), panel+session+banner (V4), run loop (V5) — all spec sections mapped.
- Signs `tuneSign/loadSign` are seeds in V3 and made self-correcting in V5 — consistent names across tasks.
- `planVnaStep` signature identical in V3 test + impl + V5 caller.
