# Closed-loop Phase 2 — the Closed-loop operator page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dedicated **Closed loop** operator page — the thermal control loop as a hero (control-ROI `mean_c` vs target, its `max_c` over-temp line, phase, vitals, ROI/mode/Start/ARM) — composed from the Phase-1 panel components so every Dashboard control stays reachable, plus an always-visible safety rail. Surface the small backend data (`control_max_c`, per-ROI roster) that makes the hero's over-temp line and the optional other-ROI overlay real.

**Architecture:** Reuse the Phase-1 presentational panels + `useOperator()`. Add pure trace/view logic in `src/lib` (TDD), two new hero components + a `ClosedLoopPage`, an always-visible `SafetyRail` in the App shell, and two low-risk read-only additions to TC-POWER's own `thermal` status snapshot. The FLIR contract stays LOCKED. The enforced 250 °C abort is a SEPARATE sub-project — here its banner/ceiling render **dormant** (never a false "safe").

**Tech Stack:** React 18 + Vite + TS (strict), plain CSS (`styles.css`/`theme.css`), frontend `node --test`, backend `uv run pytest` (Python 3.13, FastAPI). Serve/verify per `tc-power-serving-and-deploy`.

**Spec:** `docs/superpowers/specs/2026-09-08-closed-loop-page-design.md` (§6 Phase 2, §8 hero trace, §10 seams).
**Depends on:** Phase 1 (done) — panels in `src/components/`, pages in `src/pages/`, `useOperator()` + `Operator` type in `src/hooks/useOperator.ts`.

---

## Conventions (read once)

- **TDD (red→green) for all pure logic and backend**: write the failing test, run it, see it fail for the right reason, implement minimally, see it pass. Frontend pure logic → `node --test` (`npm test`). Backend → `cd backend && uv run pytest`.
- **Not unit-testable (UI/DOM/CSS)**: the hero SVG, layout, safety rail, and CSS are verified in **real Chrome** (claude-in-chrome MCP against a Vite dev preview `http://localhost:5174`; the in-app pane blocks localhost). State this gate; never skip silently.
- **Frontend gate every task**: `npx tsc --noEmit && npm test && npm run build` all green.
- **Backend gate**: `cd backend && uv run pytest && ruff check . && mypy --strict` (or the repo's configured mypy) green.
- **LIVE-BENCH deploy rule**: the backend tasks (1–2) change the operator; deploying them needs `cd frontend && npm run build` is NOT enough — the backend needs
  `launchctl kickstart -k gui/$(id -u)/com.tcpower.operator`, which **interrupts a running loop**. Do NOT restart the operator without Matt confirming the bench is clear. Backend UNIT tests run offline with no hardware — do those freely; gate only the live verification + restart on Matt.
- **Safety**: never enable RF, never actuate hardware, never engage the built-in ATUNE. The loop still never enables RF.
- **Design language**: extend the existing CXN look (tokens in `theme.css`, classes in `styles.css`); do not invent a new aesthetic. Keep files ≤400 lines. Conventional Commits; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File structure (Phase 2 additions)

```
backend/tc_power_interface/integration/flir_roi_temps.py   MODIFY: retain per-ROI temps + latest_roi_temps()
backend/tc_power_interface/api/app.py                       MODIFY: surface control_max_c + roi_temps (app.py:443)
backend/tests/test_flir_roi_temps.py                        MODIFY: roster-retention + max_c passthrough tests
frontend/src/lib/telemetry.ts                               MODIFY: ThermalStatus += control_max_c?, roi_temps?
frontend/src/lib/heroTrace.ts        (+ .test.ts)           NEW: pure SVG scaling / range-fit / band geometry
frontend/src/lib/thermalView.ts      (+ .test.ts)           NEW: phase + guard + applied presentation
frontend/src/hooks/useOperator.ts                           MODIFY: thermal history buffers, C-overlay toggle, view id
frontend/src/components/ThermalTrace.tsx                    NEW: the hero SVG
frontend/src/components/ThermalControls.tsx                 NEW: vitals + ROI/mode/Start/ARM + plan summary + dormant abort slot
frontend/src/components/ThermalHero.tsx                     NEW: composes ThermalTrace + phase strip + ThermalControls
frontend/src/components/SafetyRail.tsx                      NEW: always-visible E-STOP · RF OFF · DISARM (device)
frontend/src/pages/ClosedLoopPage.tsx                       NEW: hero + compact panels + Calibration slot
frontend/src/pages/SettingsPage.tsx                         MODIFY: add PulsePanel
frontend/src/pages/ExperimentalPage.tsx                     DELETE (replaced by ClosedLoopPage)
frontend/src/components/ThermalControlPanel.tsx             DELETE (its function moves into ThermalControls)
frontend/src/App.tsx                                        MODIFY: render SafetyRail; tab rename; view id; page switch
frontend/src/styles.css                                     MODIFY: .safety-rail, .hero-*, .calib-slot, trace classes
```

---

## Task 1: Backend — surface `control_max_c` (already computed, unsurfaced)

**Files:** Modify `backend/tc_power_interface/api/app.py`; Test `backend/tests/test_flir_roi_temps.py` (the passthrough is already covered by `select_control_temp` tests — this task only wires the existing `latest_max_c` into the snapshot).

- [ ] **Step 1: Failing test — the thermal block carries control_max_c**
Add to `backend/tests/` a small API-level test (or extend an existing app test) that builds the app with a fake FLIR source exposing `latest_max_c = 123.4` and asserts the status `thermal` block includes `"control_max_c": 123.4`. If an app-level harness is heavy, instead assert at the wiring seam: a helper `thermal_extra(source)` returning `{"control_max_c": getattr(source, "latest_max_c", None)}`.

```python
def test_thermal_block_includes_control_max_c():
    class FakeSrc:
        latest_max_c = 123.4
    from tc_power_interface.api.app import thermal_extra  # to be added
    assert thermal_extra(FakeSrc())["control_max_c"] == 123.4

def test_thermal_block_control_max_c_absent_is_none():
    class FakeSrc:
        pass
    from tc_power_interface.api.app import thermal_extra
    assert thermal_extra(FakeSrc())["control_max_c"] is None
```

- [ ] **Step 2: Run — see it fail** `cd backend && uv run pytest tests/test_flir_roi_temps.py -k control_max_c -q` → ImportError/AttributeError (thermal_extra missing).

- [ ] **Step 3: Implement** — in `app.py`, add near the thermal wiring:
```python
def thermal_extra(source: Any) -> dict[str, Any]:
    """Read-only extras surfaced alongside the thermal snapshot (loop behaviour unchanged)."""
    return {"control_max_c": getattr(source, "latest_max_c", None)}
```
and at the status assembly (app.py ~443) spread it in:
```python
            "thermal": {
                **_thermal().snapshot(),
                "source": app.state.thermal_source,
                "control_roi": app.state.control_roi,
                "available_rois": _available_rois(),
                **thermal_extra(_thermal().source),
            },
```

- [ ] **Step 4: Run — pass** `uv run pytest tests/test_flir_roi_temps.py -k control_max_c -q` → PASS. Then full `uv run pytest -q` green.

- [ ] **Step 5: Commit** `git add backend/... && git commit -m "feat(thermal): surface control_max_c in the thermal snapshot"` (+ trailer).

---

## Task 2: Backend — retain + surface a per-ROI temp roster (`roi_temps`)

**Files:** Modify `backend/tc_power_interface/integration/flir_roi_temps.py`, `backend/tc_power_interface/api/app.py`; Test `backend/tests/test_flir_roi_temps.py`.

- [ ] **Step 1: Failing test — poller retains each ROI's mean_c + valid**
Use a captured healthy payload (the file already has fixtures per [[flir-thermal-control-contract]]; reuse one, do NOT invent). 
```python
def test_poller_retains_roi_temps_roster():
    payload = {  # captured-shape healthy roster
        "live": True, "stale": False, "age_ms": 40.0,
        "rois": [
            {"name": "circle_medium_small", "mean_c": 171.4, "max_c": 180.2, "valid": True},
            {"name": "shunt_cap_FP", "mean_c": 44.0, "max_c": 46.0, "valid": True},
        ],
    }
    src = FlirPollingSource("http://x", _get=lambda *_: payload)
    src.poll_once()
    roster = src.latest_roi_temps()
    assert {"name": "circle_medium_small", "mean_c": 171.4, "valid": True} in roster
    assert {"name": "shunt_cap_FP", "mean_c": 44.0, "valid": True} in roster

def test_poller_roi_temps_survive_a_failed_poll():
    payload = {"live": True, "stale": False, "age_ms": 10.0,
               "rois": [{"name": "a", "mean_c": 1.0, "valid": True}]}
    calls = [payload, Exception("net")]
    def _get(*_):
        v = calls.pop(0)
        if isinstance(v, Exception): raise v
        return v
    src = FlirPollingSource("http://x", _get=_get)
    src.poll_once(); src.poll_once()
    assert src.latest_roi_temps() == [{"name": "a", "mean_c": 1.0, "valid": True}]
```

- [ ] **Step 2: Run — fail** `cd backend && uv run pytest tests/test_flir_roi_temps.py -k roi_temps -q` → AttributeError (`latest_roi_temps` missing).

- [ ] **Step 3: Implement** in `flir_roi_temps.py`:
  - In `__init__`: `self._roi_temps: list[dict[str, Any]] = []`.
  - In `poll_once`, after computing `names`, also build the roster and store under the lock (keep last known if a poll returns none):
```python
            roster = [
                {"name": r.get("name"), "mean_c": r.get("mean_c"), "valid": bool(r.get("valid", False))}
                for r in payload.get("rois", []) if r.get("name")
            ]
```
    (build inside the try; on exception leave `roster = []`.) Then in the locked section:
```python
            if names:
                self._roi_names = names
                self._roi_temps = roster
```
  - Add the getter:
```python
    def latest_roi_temps(self) -> list[dict[str, Any]]:
        """The last feed's per-ROI mean_c + valid (for the hero's optional overlay)."""
        with self._lock:
            return [dict(r) for r in self._roi_temps]
```

- [ ] **Step 4: Run — pass** the `-k roi_temps` tests, then full `uv run pytest -q` green.

- [ ] **Step 5: Wire into the snapshot** — extend `thermal_extra` (Task 1) to also surface the roster:
```python
def thermal_extra(source: Any) -> dict[str, Any]:
    fn = getattr(source, "latest_roi_temps", None)
    return {
        "control_max_c": getattr(source, "latest_max_c", None),
        "roi_temps": fn() if callable(fn) else [],
    }
```
Update Task 1's test if needed (add `"roi_temps": []` expectation for the FakeSrc without the method). Re-run `uv run pytest -q` + `ruff check .` + mypy → green.

- [ ] **Step 6: Commit** `feat(thermal): retain + surface a per-ROI temp roster for the hero overlay` (+ trailer).

**Deploy note:** Tasks 1–2 are live only after an operator restart — gate that on Matt (see Conventions). Frontend Tasks 3+ degrade cleanly when the fields are absent (all optional), so they can be built and browser-tested against the un-restarted operator (fields simply undefined → over-temp line/overlay not drawn).

---

## Task 3: Frontend types — extend `ThermalStatus`

**Files:** Modify `frontend/src/lib/telemetry.ts`.

- [ ] **Step 1:** Add optional fields to `ThermalStatus` (telemetry.ts:60), after `available_rois?`:
```ts
  /** Hottest pixel of the control ROI (FLIR source only; null at saturation / sim). Absent on older operators. */
  control_max_c?: number | null;
  /** Compact per-ROI roster for the optional hero overlay. Absent on older operators. */
  roi_temps?: { name: string; mean_c: number | null; valid: boolean }[];
```
- [ ] **Step 2:** `cd frontend && npx tsc --noEmit` → clean (optional fields, no breakage).
- [ ] **Step 3: Commit** `feat(thermal): type control_max_c + roi_temps on ThermalStatus`.

---

## Task 4: Pure logic — `heroTrace.ts` (TDD)

**Files:** Create `frontend/src/lib/heroTrace.ts`, `frontend/src/lib/heroTrace.test.ts`.

- [ ] **Step 1: Failing tests**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitRange, yOf, xOf, polyline } from "./heroTrace.ts";

test("fitRange always includes target and max, with headroom", () => {
  const r = fitRange([100, 150], [160], 185, 0);
  assert.equal(r.lo, 100);
  assert.equal(r.hi, 185); // target above the data is included
});
test("fitRange pads and never collapses", () => {
  const r = fitRange([], [], 185, 0.1);
  assert.ok(r.hi > r.lo);
});
test("yOf inverts (hi at top = 0)", () => {
  assert.equal(yOf(200, { lo: 0, hi: 200 }, 100), 0);
  assert.equal(yOf(0, { lo: 0, hi: 200 }, 100), 100);
});
test("xOf spreads points across width", () => {
  assert.equal(xOf(0, 5, 400), 0);
  assert.equal(xOf(4, 5, 400), 400);
});
test("polyline emits x,y pairs", () => {
  const p = polyline([0, 100], { lo: 0, hi: 100 }, 100, 50);
  assert.equal(p, "0.0,50.0 100.0,0.0");
});
```
- [ ] **Step 2: Run — fail** `npx tsc --noEmit` then `node --test src/lib/heroTrace.test.ts` (via `npm test`) → module missing.
- [ ] **Step 3: Implement** `heroTrace.ts`:
```ts
export interface Range { lo: number; hi: number; }

/** Auto-fit a temperature y-range that always includes `target` and any finite max/control, padded. */
export function fitRange(controls: number[], maxes: number[], target: number, padFrac = 0.08): Range {
  const vals = [...controls, ...maxes, target].filter((v) => Number.isFinite(v));
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : (Number.isFinite(target) && target > 0 ? target : 1);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * padFrac;
  return { lo: lo - pad, hi: hi + pad };
}

/** Map a value to a y pixel (inverted: `hi` at top = 0). */
export function yOf(v: number, r: Range, height: number): number {
  return height - ((v - r.lo) / (r.hi - r.lo)) * height;
}

/** Map point index `i` of `count` points to an x pixel across `width`. */
export function xOf(i: number, count: number, width: number): number {
  return count <= 1 ? 0 : (i / (count - 1)) * width;
}

/** SVG polyline `points` for evenly-time-spaced values. */
export function polyline(values: number[], r: Range, width: number, height: number): string {
  return values
    .map((v, i) => `${xOf(i, values.length, width).toFixed(1)},${yOf(v, r, height).toFixed(1)}`)
    .join(" ");
}
```
- [ ] **Step 4: Run — pass** `npm test` → all green (existing 46 + these).
- [ ] **Step 5: Commit** `feat(thermal): heroTrace pure SVG scaling helpers (TDD)`.

---

## Task 5: Pure logic — `thermalView.ts` (TDD)

**Files:** Create `frontend/src/lib/thermalView.ts`, `frontend/src/lib/thermalView.test.ts`.

- [ ] **Step 1: Failing tests**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASES, phaseIndex, appliedLabel, overTempGuard } from "./thermalView.ts";

test("phaseIndex advances RAMP<APPROACH<SOAK<COOL<DONE", () => {
  assert.deepEqual(PHASES, ["ramp", "approach", "soak", "cool", "done"]);
  assert.ok(phaseIndex("approach") > phaseIndex("ramp"));
  assert.equal(phaseIndex("bogus"), -1);
});
test("appliedLabel: null = advisory, number = rounded W", () => {
  assert.equal(appliedLabel(null), "advisory");
  assert.equal(appliedLabel(57.6), "58 W");
});
test("overTempGuard never reports healthy when max_c is absent", () => {
  assert.deepEqual(overTempGuard(null), { kind: "not-reported" });
  assert.deepEqual(overTempGuard(undefined), { kind: "not-reported" });
  assert.deepEqual(overTempGuard(180.2), { kind: "value", maxC: 180.2 });
});
```
- [ ] **Step 2: Run — fail** (module missing).
- [ ] **Step 3: Implement** `thermalView.ts`:
```ts
export type Phase = "ramp" | "approach" | "soak" | "cool" | "done";
export const PHASES: Phase[] = ["ramp", "approach", "soak", "cool", "done"];

export function phaseIndex(p: string): number { return PHASES.indexOf(p as Phase); }
export function appliedLabel(applied: number | null): string {
  return applied === null ? "advisory" : `${Math.round(applied)} W`;
}
export type GuardState = { kind: "value"; maxC: number } | { kind: "not-reported" };
export function overTempGuard(maxC: number | null | undefined): GuardState {
  return maxC == null ? { kind: "not-reported" } : { kind: "value", maxC };
}
```
- [ ] **Step 4: Run — pass** `npm test` green.
- [ ] **Step 5: Commit** `feat(thermal): thermalView phase/guard/applied presentation (TDD)`.

---

## Task 6: `useOperator` — thermal history buffers, C-overlay toggle, view id

**Files:** Modify `frontend/src/hooks/useOperator.ts`.

- [ ] **Step 1:** Change the view id from `"experimental"` to `"closed-loop"`:
  - `const [view, setView] = useState<"dashboard" | "settings" | "closed-loop">("dashboard");`
  - Its type flows through `Operator` (inferred). (App + pages updated in Task 12.)
- [ ] **Step 2:** Add the C-overlay toggle (localStorage, mirroring `showGauges`):
```ts
const [showRoiOverlay, setShowRoiOverlay] = useState<boolean>(() => {
  try { return localStorage.getItem("tcp.hero.overlay") === "1"; } catch { return false; }
});
const toggleRoiOverlay = (on: boolean) => {
  setShowRoiOverlay(on);
  try { localStorage.setItem("tcp.hero.overlay", on ? "1" : "0"); } catch { /* ignore */ }
};
```
- [ ] **Step 3:** Add thermal history buffers next to `fwdBuf`/`reflBuf`:
```ts
const heroBuf = useRef({ control: new TraceBuffer(300), max: new TraceBuffer(300), target: new TraceBuffer(300) });
const [heroTrace, setHeroTrace] = useState<{ control: Point[]; max: Point[]; target: Point[] }>({ control: [], max: [], target: [] });
const roiBufs = useRef(new Map<string, TraceBuffer>());
const [roiTrace, setRoiTrace] = useState<{ name: string; points: Point[] }[]>([]);
```
- [ ] **Step 4:** In the WS `onmessage` handler, after the existing `tel` plot push, push thermal samples when the loop is running (guard on `s.thermal`):
```ts
const th = s.thermal;
if (th) {
  const ts = Date.now() / 1000;
  if (th.running) {
    heroBuf.current.control.push(ts, th.control_temp_c);
    if (th.control_max_c != null) heroBuf.current.max.push(ts, th.control_max_c);
    heroBuf.current.target.push(ts, th.target_c);
    for (const r of th.roi_temps ?? []) {
      if (r.mean_c == null) continue;
      let b = roiBufs.current.get(r.name);
      if (!b) { b = new TraceBuffer(300); roiBufs.current.set(r.name, b); }
      b.push(ts, r.mean_c);
    }
    setHeroTrace({ control: heroBuf.current.control.toArray(), max: heroBuf.current.max.toArray(), target: heroBuf.current.target.toArray() });
    setRoiTrace([...roiBufs.current.entries()].map(([name, b]) => ({ name, points: b.toArray() })));
  }
}
```
- [ ] **Step 5:** Return the new values on the `Operator` object: `showRoiOverlay, toggleRoiOverlay, heroTrace, roiTrace`.
- [ ] **Step 6: Gate** `npx tsc --noEmit && npm test && npm run build` green. (No behaviour change to existing views; new fields unused until Task 9/11.)
- [ ] **Step 7: Commit** `feat(thermal): buffer hero trace history + C-overlay toggle in useOperator`.

---

## Task 7: `ThermalTrace` component (the hero SVG — option B resting + C toggle)

**Files:** Create `frontend/src/components/ThermalTrace.tsx`. Verified in browser (SVG rendering is not unit-testable; its math is Task 4).

- [ ] **Step 1:** Component:
```tsx
import type { Point } from "../lib/telemetry.ts";
import { fitRange, polyline, yOf } from "../lib/heroTrace.ts";

interface ThermalTraceProps {
  control: Point[]; max: Point[]; target: Point[];
  roi: { name: string; points: Point[] }[];
  showOverlay: boolean;
  targetC: number; bandC: number; // approach_band_c for the band
}

const W = 720, H = 260; // viewBox; the SVG scales to its container via width:100%

export function ThermalTrace({ control, max, target, roi, showOverlay, targetC, bandC }: ThermalTraceProps) {
  const cv = control.map((p) => p.v), mv = max.map((p) => p.v);
  const r = fitRange(cv, mv, targetC);
  const yTarget = yOf(targetC, r, H);
  const yBandLo = yOf(targetC - bandC, r, H), yBandHi = yOf(targetC + bandC, r, H);
  return (
    <svg className="hero-trace" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="control temperature vs target">
      {/* approach band */}
      <rect x="0" y={yBandHi} width={W} height={Math.max(0, yBandLo - yBandHi)} className="hero-band" />
      {/* target */}
      <line x1="0" y1={yTarget} x2={W} y2={yTarget} className="hero-target" />
      {/* other ROIs (faint, toggle) */}
      {showOverlay && roi.map((s) => (
        <polyline key={s.name} className="hero-roi" fill="none" points={polyline(s.points.map((p) => p.v), r, W, H)} />
      ))}
      {/* max_c (over-temp awareness) — only when present */}
      {mv.length > 0 && (
        <polyline className="hero-max" fill="none" points={polyline(mv, r, W, H)} />
      )}
      {/* control ROI mean_c (thick, live) */}
      <polyline className="hero-control" fill="none" points={polyline(cv, r, W, H)} />
    </svg>
  );
}
```
Note: the enforced 250 °C ceiling line is deliberately NOT drawn (belongs to the abort sub-project). When `max` is empty (older operator / sim), no red line renders (honest absence).
- [ ] **Step 2: Gate** tsc/test/build green.
- [ ] **Step 3: Commit** `feat(thermal): ThermalTrace hero SVG (control mean + max_c + target band + ROI overlay)`.

---

## Task 8: `ThermalControls` component (vitals + controls + dormant abort slot)

**Files:** Create `frontend/src/components/ThermalControls.tsx`. Reuses the exact handlers/markup from the old `ThermalControlPanel` (source select, ROI dropdown, mode, Start/Stop, Arm/Disarm) — copy that JSX verbatim so behaviour is unchanged — plus big vitals readouts and a dormant abort slot.

- [ ] **Step 1:** Props = the ThermalControlPanel props PLUS `controlMaxC: number | null | undefined` and a `bandC: number` (from the plan) for the plan summary. Structure:
```tsx
import type { CSSProperties } from "react";
import type { Telemetry, ThermalStatus } from "../lib/telemetry.ts";
import { fmtTemp, fmtWatts } from "../lib/format.ts";
import { appliedLabel, overTempGuard } from "../lib/thermalView.ts";

interface ThermalControlsProps {
  controllable: boolean; connected: boolean; t: Telemetry | null; thermal: ThermalStatus | undefined;
  thermalMode: "advisory" | "auto"; setThermalMode: (v: "advisory" | "auto") => void;
  thermalFlirUrl: string; setThermalFlirUrl: (v: string) => void;
  startThermal: () => void; stopThermal: () => void; armThermal: () => void; disarmThermal: () => void;
  applyThermalSource: (t: "simulated" | "flir") => void; applyControlRoi: (name: string) => void;
  setView: (v: "dashboard" | "settings" | "closed-loop") => void; // for the "edit plan" link
  textInputStyle: CSSProperties;
}
```
- [ ] **Step 2:** Render, in order:
  - **Dormant ABORT slot** (§10): `<div className="abort-slot" hidden={!thermal?.aborted}>` — since `aborted` does not exist on the type yet, render a static disabled affordance instead: a muted line "Over-temp abort: not yet armed (separate build)" ONLY as a small hint, never styled as "safe/OK". Do NOT fabricate an aborted state. Concretely:
    ```tsx
    <div className="abort-slot dormant">over-temp abort — arms with the calibration build</div>
    ```
  - **Big vitals**: control-temp→target (`fmtTemp(thermal.control_temp_c) → fmtTemp(thermal.target_c)`), recommended→applied (`fmtWatts(thermal.recommended_w) → appliedLabel(thermal.applied_w)`), a max_c line driven by `overTempGuard(controlMaxC)` (show the value or "max: not reported" — never a false OK), and the reason string if present.
  - **ROI selector / source / mode / Start-Stop / Arm-Disarm**: copy verbatim from `ThermalControlPanel.tsx:78-172` (the source select, FLIR url, control-ROI dropdown with the "not in live feed" flag, mode select, Start/Stop, Arm/Disarm). Behaviour identical.
  - **Plan summary + edit link**: a mono line `target {thermal.target_c} · soak … · ceiling …` — but the plan detail lives in `thermalPlanStatus` (Settings). Keep it simple: show `target {fmtTemp(thermal.target_c)}` and a button `onClick={() => setView("settings")}`: "edit plan".
  Rename the two arm/disarm buttons' labels to **"ARM LOOP" / "DISARM LOOP"** (this is a label change only — the handlers `armThermal`/`disarmThermal` are unchanged; the global rail owns device DISARM).
- [ ] **Step 3: Gate** tsc/test/build.
- [ ] **Step 4: Commit** `feat(thermal): ThermalControls (vitals, ROI/mode/loop controls, dormant abort slot)`.

---

## Task 9: `ThermalHero` component (compose trace + phase strip + controls)

**Files:** Create `frontend/src/components/ThermalHero.tsx`.

- [ ] **Step 1:** Compose:
```tsx
import { PHASES, phaseIndex } from "../lib/thermalView.ts";
import { ThermalTrace } from "./ThermalTrace.tsx";
import { ThermalControls } from "./ThermalControls.tsx";
import type { Operator } from "../hooks/useOperator.ts";

export function ThermalHero({ op }: { op: Operator }) {
  const { thermal, heroTrace, roiTrace, showRoiOverlay, toggleRoiOverlay } = op;
  const idx = phaseIndex(thermal?.phase ?? "");
  const bandC = 15; // TODO wire from thermalPlanStatus.approach_band_c when available on op (see Step 2)
  return (
    <section className="panel hero">
      <div className="hero-head">
        <h2>Closed-loop thermal control</h2>
        <label className="toggle"><input type="checkbox" checked={showRoiOverlay}
          onChange={(e) => toggleRoiOverlay(e.target.checked)} /> Other ROIs</label>
      </div>
      <div className="phase-strip">
        {PHASES.map((p, i) => (
          <span key={p} className={`ph ${i === idx ? "on" : ""} ${i < idx ? "done" : ""}`}>{p.toUpperCase()}</span>
        ))}
      </div>
      <div className="hero-body">
        <ThermalTrace control={heroTrace.control} max={heroTrace.max} target={heroTrace.target}
          roi={roiTrace} showOverlay={showRoiOverlay} targetC={thermal?.target_c ?? 185} bandC={bandC} />
        <ThermalControls
          controllable={op.controllable} connected={op.connected} t={op.t} thermal={op.thermal}
          thermalMode={op.thermalMode} setThermalMode={op.setThermalMode}
          thermalFlirUrl={op.thermalFlirUrl} setThermalFlirUrl={op.setThermalFlirUrl}
          startThermal={op.startThermal} stopThermal={op.stopThermal}
          armThermal={op.armThermal} disarmThermal={op.disarmThermal}
          applyThermalSource={op.applyThermalSource} applyControlRoi={op.applyControlRoi}
          setView={op.setView} textInputStyle={op.textInputStyle}
          controlMaxC={op.thermal?.control_max_c} />
      </div>
    </section>
  );
}
```
- [ ] **Step 2 (band wiring):** expose `thermalPlanStatus` on `op` (already returned) and pass `bandC={op.thermalPlanStatus?.approach_band_c ?? 15}` instead of the TODO const. Remove the TODO.
- [ ] **Step 3: Gate** tsc/test/build.
- [ ] **Step 4: Commit** `feat(thermal): ThermalHero — phase strip + trace + controls`.

---

## Task 10: `SafetyRail` — always-visible safe-direction controls

**Files:** Create `frontend/src/components/SafetyRail.tsx`. New behaviour (global), verified in browser.

- [ ] **Step 1:** Component (E-STOP · RF OFF · device DISARM; disabled states mirror the panel's):
```tsx
interface SafetyRailProps {
  connected: boolean; armed: boolean;
  estop: () => void; rfOff: () => void; disarmDevice: () => void;
}
export function SafetyRail({ connected, armed, estop, rfOff, disarmDevice }: SafetyRailProps) {
  return (
    <div className="safety-rail" role="toolbar" aria-label="safety controls">
      <button className="btn estop" onClick={estop} disabled={!connected} title="Emergency stop: RF off, setpoint 0, all drivers halted">⏻ E-STOP</button>
      <button className="btn" onClick={rfOff} disabled={!connected}>RF OFF</button>
      <button className="btn" onClick={disarmDevice} disabled={!connected || !armed} title="Drop control: RF off, back to read-only">DISARM</button>
    </div>
  );
}
```
- [ ] **Step 2:** In `App.tsx`, render `<SafetyRail connected={connected} armed={armed} estop={estop} rfOff={rfOff} disarmDevice={disarmDevice} />` directly under `</header>` (before `<Banners/>`). Add `estop, rfOff, disarmDevice, armed` to App's destructure (they already exist on `op`).
- [ ] **Step 3: Gate** tsc/test/build.
- [ ] **Step 4: Commit** `feat(ui): always-visible SafetyRail (E-STOP / RF OFF / DISARM) on every page`.

---

## Task 11: `ClosedLoopPage` — compose the page

**Files:** Create `frontend/src/pages/ClosedLoopPage.tsx`.

- [ ] **Step 1:** Compose the hero (full width) + a compact two-column band reusing Phase-1 panels + a reserved Calibration slot:
```tsx
import type { Operator } from "../hooks/useOperator.ts";
import { ThermalHero } from "../components/ThermalHero.tsx";
import { RfPowerPanel } from "../components/RfPowerPanel.tsx";
import { TelemetryPanel } from "../components/TelemetryPanel.tsx";
import { HistoryPanel } from "../components/HistoryPanel.tsx";
import { MatchingNetworkPanel } from "../components/MatchingNetworkPanel.tsx";
import { MatchTunerPanel } from "../components/MatchTunerPanel.tsx";

export function ClosedLoopPage({ op }: { op: Operator }) {
  return (
    <div className="closed-loop">
      <ThermalHero op={op} />
      <div className="main">
        <div className="col">
          <RfPowerPanel {/* …the exact Task-5 Phase-1 props from op… */} />
          <TelemetryPanel {/* …gauges props from op… */} />
          <HistoryPanel plot={op.plot} powerCeil={op.powerCeil} />
        </div>
        <div className="col">
          <MatchingNetworkPanel {/* …props from op… */} />
          <MatchTunerPanel {/* …props from op… */} />
          <section className="panel calib-slot">
            <h2>Calibration</h2>
            <div className="hint">Reserved for the calibration routine — step tests, <code>calibration.json</code> status, per-session absorbed-power fit.</div>
          </section>
        </div>
      </div>
    </div>
  );
}
```
Fill the `{…props…}` by copying the exact prop lists from `DashboardPage.tsx` for each panel (they read from the same `op`). This keeps those panels behaviour-identical to the Dashboard.
- [ ] **Step 2: Gate** tsc/test/build.
- [ ] **Step 3: Commit** `feat(thermal): ClosedLoopPage composed from the shared panels + hero + calibration slot`.

---

## Task 12: Wire the page in — tab rename, PULSE → Settings, delete leftovers

**Files:** Modify `frontend/src/App.tsx`, `frontend/src/pages/SettingsPage.tsx`; Delete `frontend/src/pages/ExperimentalPage.tsx`, `frontend/src/components/ThermalControlPanel.tsx`.

- [ ] **Step 1:** In `App.tsx` topbar, rename the third tab button label `Experimental` → `Closed loop`, its `view === "experimental"` → `view === "closed-loop"`, and `onClick={() => setView("closed-loop")}`.
- [ ] **Step 2:** In the page switch, replace `<ExperimentalPage op={op} />` with `<ClosedLoopPage op={op} />` and import it (drop the ExperimentalPage import).
- [ ] **Step 3:** In `SettingsPage.tsx`, add `<PulsePanel …/>` (copy its prop list from the old ExperimentalPage) at the end of the settings column, and its import; add the PULSE fields to the SettingsPage destructure.
- [ ] **Step 4:** `git rm frontend/src/pages/ExperimentalPage.tsx frontend/src/components/ThermalControlPanel.tsx`.
- [ ] **Step 5: Gate** `npx tsc --noEmit && npm test && npm run build` green (tsc confirms nothing else imports the deleted files).
- [ ] **Step 6: Commit** `feat(ui): rename Experimental→Closed loop, fold PULSE into Settings, drop the old thermal panel`.

---

## Task 13: CSS — hero, safety rail, calibration slot, trace strokes

**Files:** Modify `frontend/src/styles.css`. Not unit-testable → browser gate (Task 14). Extend the existing tokens; do not invent new colours.

- [ ] **Step 1:** Add, using existing tokens:
```css
/* Always-visible safety rail (under the topbar, every page) */
.safety-rail { display: flex; gap: 8px; align-items: center; padding: 6px 16px;
  background: var(--bg-deep); border-bottom: 1px solid var(--line); }
.safety-rail .btn { padding: 6px 14px; }
.safety-rail .btn.estop { font-size: 13px; padding: 6px 16px; }

/* Closed-loop hero */
.closed-loop { display: flex; flex-direction: column; gap: calc(var(--space) * 4);
  padding: calc(var(--space) * 4); overflow: auto; }
.panel.hero { border-color: var(--accent); }
.hero-head { display: flex; justify-content: space-between; align-items: center; }
.hero-body { display: grid; grid-template-columns: 1.7fr 1fr; gap: calc(var(--space) * 4); margin-top: 10px; }
.phase-strip { display: flex; gap: 6px; margin-top: 10px; }
.phase-strip .ph { flex: 1; text-align: center; font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0.04em; padding: 5px 0; border: 1px solid var(--line-strong); border-radius: 2px; color: var(--muted); }
.phase-strip .ph.on { background: var(--live); color: var(--bg); border-color: var(--live); font-weight: 700; }
.phase-strip .ph.done { color: var(--live); }

/* Hero trace SVG */
.hero-trace { width: 100%; height: 260px; background: var(--bg-deep); border: 1px solid var(--line); border-radius: var(--radius); }
.hero-band { fill: var(--accent); opacity: 0.10; }
.hero-target { stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 5 4; }
.hero-control { stroke: var(--live); stroke-width: 2.6; }
.hero-max { stroke: var(--err); stroke-width: 1.6; opacity: 0.9; }
.hero-roi { stroke: var(--muted); stroke-width: 1.2; opacity: 0.45; }

/* Dormant abort slot + calibration slot */
.abort-slot.dormant { font-family: var(--font-mono); font-size: 10px; color: var(--muted);
  border: 1px dashed var(--line-control); border-radius: var(--radius); padding: 5px 9px; margin-bottom: 10px; }
.panel.calib-slot { border-style: dashed; border-color: var(--line-control); }
```
- [ ] **Step 2:** Responsive: at narrow widths collapse `.hero-body` and `.main` to one column — add `@media (max-width: 900px) { .hero-body, .main { grid-template-columns: 1fr; } }`.
- [ ] **Step 3: Gate** `npm run build` clean (CSS compiles).
- [ ] **Step 4: Commit** `style(thermal): hero / safety-rail / calibration-slot / trace styling (CXN tokens)`.

---

## Task 14: Verification — real-Chrome walkthrough

**Files:** none.

- [ ] **Step 1:** `cd frontend && npx tsc --noEmit && npm test && npm run build` — all green; confirm every file ≤400 lines (`find src -name '*.tsx' -o -name '*.ts' | grep -v .test. | xargs wc -l | awk '$1>400'` → only `useOperator.ts`).
- [ ] **Step 2:** Start `npm run dev` (port 5174); via claude-in-chrome (real Chrome), load `http://localhost:5174`. Confirm READ-ONLY (never click RF/ARM/caps/Start on the live bench):
  - Three tabs `Dashboard | Closed loop | Settings`; the safety rail (E-STOP / RF OFF / DISARM) shows on all three.
  - Closed-loop page: hero renders (phase strip, trace area with target line + band; control/max lines appear once the loop is running or on sim), vitals readouts, ROI selector, mode, Start/ARM LOOP/DISARM LOOP, plan summary + edit link; compact RF power, gauges, history, matching network, match tuner, and the dashed Calibration slot below.
  - Dashboard unchanged from Phase 1; Settings now includes the Pulse panel.
  - `read_console_messages` (onlyErrors) → no app errors (Zotero-extension noise is fine).
  - Toggle "Other ROIs" → faint overlays appear/disappear (visible only with a running FLIR loop + roi_temps present).
  - Screenshot each view; share with Matt.
- [ ] **Step 3:** Stop the dev server; close the tab.
- [ ] **Step 4 (gated on Matt):** to see `control_max_c`/`roi_temps` live, the operator must be restarted after the backend build — confirm bench timing with Matt first, then `cd frontend && npm run build` + `launchctl kickstart -k gui/$(id -u)/com.tcpower.operator`, and re-check the hero's max line + overlay against live FLIR.

---

## Self-Review (run against the spec)

- **Spec coverage:** §6.1 backend surfacing → Tasks 1–2; frontend types → Task 3; §6.3 pure logic (heroTrace, thermalView) + thermal buffer → Tasks 4–6; §6.2 ThermalHero/ThermalTrace/ThermalControls → Tasks 7–9; SafetyRail → Task 10; ClosedLoopPage compose → Task 11; tab rename + PULSE→Settings → Task 12; §8 hero-trace visual (B resting + C toggle, no enforced ceiling line) → Tasks 7 + 13; §10 dormant abort seam + Calibration slot → Tasks 8 + 11; verification/deploy gate → Task 14.
- **Placeholder scan:** the only deliberate deferrals are the enforced abort (separate sub-project — rendered dormant, not faked) and the `useOperator` split (Matt chose to keep it cohesive). The Task-9 `bandC` TODO is resolved in Task-9 Step 2. Panel prop lists in Tasks 8/11 say "copy the exact list from DashboardPage/ThermalControlPanel" — those files are the concrete source, not a vague placeholder.
- **Type consistency:** `ThermalStatus.control_max_c?`/`roi_temps?` (Task 3) are consumed in Tasks 6/8/9; `Operator` gains `showRoiOverlay/toggleRoiOverlay/heroTrace/roiTrace` (Task 6) consumed in Task 9; the view id `"closed-loop"` is introduced in Task 6 and used in Tasks 8/11/12; `heroTrace.ts`/`thermalView.ts` exports match their consumers.
- **Scope:** single coherent page build; the abort law and calibration content are explicit out-of-scope seams.

---

## Out of scope (seams, per the spec §10/§11)
- The enforced 250 °C latched max-temp abort (its own coordinated sub-project + Matt's trip number).
- The Calibration section's content (the sibling calibration-routine session fills the reserved slot).
- Any RF enable / hardware actuation; FLIR-side changes; control-quality retuning.
