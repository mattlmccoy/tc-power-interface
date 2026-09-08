# Closed-loop Phase 1 — Dashboard component extraction (pure refactor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every inline panel in the 2016-line `frontend/src/App.tsx` into focused, reusable, presentational components fed by a single `useOperator()` state hook — with **zero behavior change and a pixel-identical UI** — so Phase 2 can compose a Closed-loop page from the same components.

**Architecture:** Move all state/refs/effects/handlers out of `App()` into one `useOperator()` hook called **once** at the top of `App` (keeps the telemetry WebSocket a singleton across renders/pages). Each panel becomes a presentational component taking a typed props slice. The three views become `DashboardPage` / `SettingsPage` / `ExperimentalPage`. No new features; the Experimental tab and PULSE stay exactly where they are (they move in Phase 2).

**Tech Stack:** React 18 + Vite + TypeScript (strict), plain CSS (`styles.css`/`theme.css`), `node --test`. Serve/verify per `tc-power-serving-and-deploy`: real Chrome (claude-in-chrome MCP) against `http://127.0.0.1:8010` — the in-app Browser pane blocks localhost.

**Spec:** `docs/superpowers/specs/2026-09-08-closed-loop-page-design.md` (§ "Phase 1").

---

## Conventions (read once, apply every task)

**This is a refactor of pure UI/DOM, which is not unit-testable in the red-green sense.** Per the project TDD rule, the substituted verification gate for EVERY task is:

```bash
cd frontend
npx tsc --noEmit          # strict types clean
npm test                  # the 46 existing lib tests stay green (unaffected — they test src/lib/*)
npm run build             # vite build clean
```

Plus, at the two **milestone gates** (after Task 1, and after the final task), a **visual A/B in real Chrome**: build, ensure the operator serves the fresh `dist` (ask Matt before any `launchctl kickstart`; for read-only visual checks prefer a Vite dev preview or the already-running operator), then compare Dashboard / Settings / Experimental against the pre-refactor screenshots — they must be **pixel-identical**. Capture before-shots at the very start (Task 0).

**Extraction recipe (mechanical move — applied per panel task):**
1. Create `src/components/<Name>.tsx` with a `Props` interface (given in full per task — this is the only net-new code).
2. Move the panel's JSX (identified by its `<h2>` title + as-of-HEAD line range) **verbatim** into the component's return, changing ONLY bare identifiers to `props.` references (or destructured props). Do not alter markup, classNames, inline styles, `disabled=` conditions, titles, or copy — byte-for-byte identical output.
3. In the parent, replace the moved JSX with `<Name … />`, passing each prop from the value it referenced before.
4. Run the per-task gate; commit.

**Line ranges are as-of HEAD** (`8bac48c`) and will drift as panels are removed — locate each panel by its `<h2>` heading, not the number. Extract in the given order (leaves before pages).

**Commit style:** Conventional Commits, one panel per commit, e.g. `refactor(frontend): extract RfPowerPanel from App`. End every commit message with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Hard rules:** never change behavior, copy, classNames, or `disabled` logic; never enable RF or actuate hardware; keep every file ≤400 lines; match surrounding idiom/comment density.

---

## File structure (end state of Phase 1)

```
src/hooks/useOperator.ts        ← ALL state/refs/effects/handlers; returns the Operator object
src/App.tsx                      ← thin shell: useOperator() + chrome + <ActivePage>  (~90 lines)
src/pages/
  DashboardPage.tsx  SettingsPage.tsx  ExperimentalPage.tsx
src/components/
  ConnectBar.tsx  Banners.tsx  Toast.tsx  StartupModal.tsx
  TelemetryPanel.tsx  RfPowerPanel.tsx  GeneratorPanel.tsx  HistoryPanel.tsx
  MatchingNetworkPanel.tsx  MatchTunerPanel.tsx  TimerPanel.tsx  RecordingPanel.tsx
  SafetyLimitsPanel.tsx  ThermalPlanPanel.tsx  LoggingPanel.tsx  FlirLinkPanel.tsx  OperatorPanel.tsx
  ThermalControlPanel.tsx  PulsePanel.tsx
```
Reused unchanged: `components/{Gauge,StatusLeds,TimePlot,ErrorBoundary}.tsx`, all of `src/lib/*`.
If `useOperator.ts` exceeds 400 lines, Task 16 splits it into sub-hooks.

---

## Task 0: Capture the before-state baseline

**Files:** none (screenshots only).

- [ ] **Step 1: Build and serve the current app unchanged**

Run:
```bash
cd frontend && npm ci && npx tsc --noEmit && npm test && npm run build
```
Expected: types clean, **46 tests pass**, build succeeds. This confirms the starting point compiles/tests green before touching anything.

- [ ] **Step 2: Capture reference screenshots of all three views**

Using the claude-in-chrome MCP against the running operator at `http://127.0.0.1:8010` (per `tc-power-serving-and-deploy`; do NOT restart the operator), screenshot **Dashboard**, **Settings**, and **Experimental** at a fixed window size. Also capture Dashboard with **analog gauges toggled on**, the **connect popover open**, and the **startup modal**. Save them as the A/B baseline. These are the pixel-equivalence oracle for Task 1 and the final gate.

- [ ] **Step 3: No commit** (baseline only).

---

## Task 1: Extract `useOperator()` — move ALL state/logic out of App

This is the crux. It moves every `useState`/`useRef`/`useEffect`/handler/derived value from `App()` into one hook, and has `App` destructure them, leaving **all JSX byte-identical**.

**Files:**
- Create: `src/hooks/useOperator.ts`
- Modify: `src/App.tsx` (top of the component only; JSX unchanged)

- [ ] **Step 1: Create the hook and define its return contract**

Create `src/hooks/useOperator.ts`. Move, **verbatim**, the entire body of `App()` from `App.tsx:36` (`const [status, setStatus] …`) through the end of the handler/derived block at `App.tsx:703` (the `textInputStyle` const) into a function `useOperator()`. Keep every import those lines need (move the needed imports to the hook file). At the end of the hook, return an object with **exactly these keys** (the `Operator` contract — group comments for readability):

```ts
export interface Operator {
  // raw + connection
  status: Status | null; reachable: boolean; health: Health | null;
  base: string; baseInput: string; setBaseInput: (v: string) => void; applyBase: () => void;
  // view + display toggles
  view: "dashboard" | "settings" | "experimental"; setView: (v: Operator["view"]) => void;
  showGauges: boolean; toggleGauges: (on: boolean) => void;
  showHelp: boolean; toggleHelp: () => void;
  showStartup: boolean; setShowStartup: (v: boolean) => void;
  // toast
  toast: { msg: string; tone: "ok" | "err" | "warn" } | null; flash: (msg: string, tone?: "ok" | "err" | "warn") => void;
  // connect popover
  showConnect: boolean; setShowConnect: (v: boolean) => void;
  ports: SerialPort[] | null; connectBusy: string | null; connectErr: string | null;
  scanPorts: () => Promise<void>; connectPort: (p: string) => Promise<void>;
  disconnectDevice: () => Promise<void>; armDevice: () => Promise<void>; disarmDevice: () => Promise<void>;
  // setpoint / rf / power
  setpointInput: string; setSetpointInput: (v: string) => void;
  applySetpoint: () => Promise<void>; nudgeSetpoint: (d: number) => void;
  onSetpointKey: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  rfOn: () => Promise<void>; rfOff: () => Promise<void>; estop: () => Promise<void>;
  rampForm: { init_w: string; target_w: string; rate_w_per_s: string }; setRampForm: (v: Operator["rampForm"]) => void;
  startRamp: () => Promise<void>; stopRamp: () => Promise<void>;
  // caps / matching network
  tune: number; load: number; activeCap: "tune" | "load"; setActiveCap: (c: "tune" | "load") => void;
  capBusy: null | "tune" | "load";
  tuneVIn: string; setTuneVIn: (v: string) => void; loadVIn: string; setLoadVIn: (v: string) => void;
  sendTune: (v: number) => Promise<void>; sendLoad: (v: number) => Promise<void>;
  bumpTune: (d: number) => void; bumpLoad: (d: number) => void; bumpActive: (d: number) => void;
  applyTuneVolts: () => void; applyLoadVolts: () => void;
  saveSlot: string; setSaveSlot: (v: string) => void;
  savePreset: (n: number) => Promise<void>; clearPreset: (n: number) => Promise<void>; recallPreset: (n: number) => Promise<void>;
  // match tuner
  setMatchMode: (m: string) => Promise<void>; startMatchTuner: () => Promise<void>; stopMatchTuner: () => Promise<void>;
  armMatchTuner: () => Promise<void>; disarmMatchTuner: () => Promise<void>;
  revPct: (f: number | null | undefined) => string; fmtDelta: (d: number) => string;
  // timer / recording
  timerMin: string; setTimerMin: (v: string) => void; startTimer: () => Promise<void>; stopTimer: () => Promise<void>;
  runName: string; setRunName: (v: string) => void; lastRun: string | null; autoLog: boolean; setAutoLog: (v: boolean) => void;
  // settings forms
  limitsStatus: SafetyLimitsStatus | null; limForm: Record<string, string>; setLimForm: (v: Operator["limForm"]) => void; saveLimits: () => Promise<void>;
  thermalPlanStatus: ThermalPlanStatus | null; thermalForm: Record<string, string>; setThermalForm: (v: Operator["thermalForm"]) => void; saveThermalPlan: () => Promise<void>;
  flirUrlInput: string; setFlirUrlInput: (v: string) => void; flirEnabled: boolean; flirLast: FlirLink["last_result"] | null;
  applyFlirUrl: () => void; toggleFlirEnabled: (on: boolean) => void;
  // thermal loop (experimental) + pulse
  thermalMode: "advisory" | "auto"; setThermalMode: (v: "advisory" | "auto") => void;
  thermalFlirUrl: string; setThermalFlirUrl: (v: string) => void;
  startThermal: () => Promise<void>; stopThermal: () => Promise<void>; armThermal: () => Promise<void>; disarmThermal: () => Promise<void>;
  applyThermalSource: (t: "simulated" | "flir") => Promise<void>; applyControlRoi: (name: string) => Promise<void>;
  pulseForm: { on_ms: string; off_ms: string; power_w: string }; setPulseForm: (v: Operator["pulseForm"]) => void;
  startPulse: () => Promise<void>; stopPulse: () => Promise<void>;
  // plot + derived (computed each render inside the hook, returned ready-to-render)
  plot: { fwd: Point[]; refl: Point[] };
  ctrl: Snapshot | undefined; t: Telemetry | null; limits: Limits | undefined; device: DeviceInfo | undefined;
  recording: Status["recording"] | undefined; thermal: ThermalStatus | undefined; ramp: RampStatus | undefined;
  timer: TimerStatus | undefined; presets: PresetsStatus | undefined; pulse: PulseStatus | undefined; mt: MatchTunerStatus | undefined;
  presetEntries: (readonly [number, PresetSlot])[];
  connected: boolean; armed: boolean; controllable: boolean; faulted: boolean;
  pillState: "disconnected" | "fault" | "connected"; handshake: ReturnType<typeof checkHandshake> | null;
  maxRefl: number; reflW: number; zone: string; reflFillPct: number; powerCeil: number;
  fwdCaution: number | null; fwdDanger: number | null; requested: number | null;
  textInputStyle: React.CSSProperties;
}

export function useOperator(): Operator { /* moved body */ return { /* all keys above */ }; }
```

Keep the internal refs (`setpointRef`, `capReadRef`, `capsTouchedAt`, `fwdBuf`, `reflBuf`, `store`) **inside** the hook (not returned) — they are internal, exactly as today. Keep `waitCapSettle`, `sendSetpoint`, `applyCapVolts`, `applyFlirLink`, `fillLimForm`, `fillThermalForm` internal too (used only by returned handlers). The WS effect, config-load effect, health effect, and cap-mirror effect move verbatim into the hook.

- [ ] **Step 2: Reduce `App()` to consume the hook**

At the top of `App()` replace the entire moved block with:
```ts
const op = useOperator();
const {
  status, reachable, health, toast, view, setView, showGauges, toggleGauges, showHelp, toggleHelp,
  showStartup, setShowStartup, setpointInput, setSetpointInput, applySetpoint, nudgeSetpoint,
  onSetpointKey, rfOn, rfOff, estop, rampForm, setRampForm, startRamp, stopRamp, tune, load,
  activeCap, setActiveCap, capBusy, tuneVIn, setTuneVIn, loadVIn, setLoadVIn, sendTune, sendLoad,
  bumpTune, bumpLoad, bumpActive, applyTuneVolts, applyLoadVolts, saveSlot, setSaveSlot, savePreset,
  clearPreset, recallPreset, setMatchMode, startMatchTuner, stopMatchTuner, armMatchTuner,
  disarmMatchTuner, revPct, fmtDelta, timerMin, setTimerMin, startTimer, stopTimer, runName,
  setRunName, lastRun, autoLog, setAutoLog, limitsStatus, limForm, setLimForm, saveLimits,
  thermalPlanStatus, thermalForm, setThermalForm, saveThermalPlan, flirUrlInput, setFlirUrlInput,
  flirEnabled, flirLast, applyFlirUrl, toggleFlirEnabled, thermalMode, setThermalMode, thermalFlirUrl,
  setThermalFlirUrl, startThermal, stopThermal, armThermal, disarmThermal, applyThermalSource,
  applyControlRoi, pulseForm, setPulseForm, startPulse, stopPulse, plot, ctrl, t, limits, device,
  recording, thermal, ramp, timer, presets, pulse, mt, presetEntries, connected, armed, controllable,
  faulted, pillState, handshake, maxRefl, reflW, zone, reflFillPct, powerCeil, fwdCaution, fwdDanger,
  requested, textInputStyle, base, baseInput, setBaseInput, applyBase, showConnect, setShowConnect,
  ports, connectBusy, connectErr, scanPorts, connectPort, disconnectDevice, armDevice, disarmDevice,
} = op;
```
The JSX from `App.tsx:705` (`return (…)`) downward stays **byte-identical**.

- [ ] **Step 3: Type-check, test, build**

Run:
```bash
cd frontend && npx tsc --noEmit && npm test && npm run build
```
Expected: types clean; **46 tests pass**; build clean. Fix any type errors by matching the interface to the moved code (do not change runtime behavior).

- [ ] **Step 4: MILESTONE visual A/B**

In real Chrome against `:8010`, compare Dashboard / Settings / Experimental (+ gauges-on, connect popover, startup modal) to the Task-0 baselines. Must be **pixel-identical**. If anything differs, a value was mis-wired — diff against baseline and fix before committing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useOperator.ts frontend/src/App.tsx
git commit -m "refactor(frontend): extract all App state/logic into useOperator() hook

No behavior change: App now calls useOperator() once and destructures it;
JSX is byte-identical. WS stays a singleton (hook called once).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Panel-extraction tasks (2–13): shared shape

Each of Tasks 2–13 follows the **Extraction recipe** above. For each: create the component with the given `Props`, move the panel JSX verbatim (locate by `<h2>`), wire it in the parent (still `App.tsx` at this stage — pages come in Task 14), then run `npx tsc --noEmit && npm test && npm run build` and commit. **A worked example (Task 5) shows the full pattern once; the rest give the exact interface + anchor + prop wiring.**

---

## Task 2: `ConnectBar` (topbar pill + connect popover)

**Files:** Create `src/components/ConnectBar.tsx`; Modify `src/App.tsx` (topbar `.connect-wrap`, `App.tsx:737-850`, and the version footer).

- [ ] **Step 1: Interface**
```ts
interface ConnectBarProps {
  pillState: "disconnected" | "fault" | "connected";
  showConnect: boolean; setShowConnect: (v: boolean) => void;
  ports: SerialPort[] | null; connectBusy: string | null; connectErr: string | null;
  connected: boolean; device: DeviceInfo | undefined;
  reachable: boolean; health: Health | null;
  baseInput: string; setBaseInput: (v: string) => void; applyBase: () => void;
  scanPorts: () => void; connectPort: (p: string) => void; disconnectDevice: () => void;
  setPorts: (p: null) => void; setConnectErr: (e: null) => void;
}
```
Note: the "Apply operator address" button calls `applyBase(); setPorts(null); setConnectErr(null);`. Expose `setPorts`/`setConnectErr` on the `Operator` contract (add them to the returned object in `useOperator`) OR wrap the three-call sequence in a new `op.applyOperatorAddress()` handler — **pick the wrapper** (cleaner; add `applyOperatorAddress` to `Operator` and drop `setPorts`/`setConnectErr` from props).
- [ ] **Step 2:** Move `App.tsx:737-850` (`<div className="connect-wrap">…</div>`) verbatim into `ConnectBar`; keep `SITE_MODE`, `UI_VERSION`, `UI_API_VERSION` imports in the component.
- [ ] **Step 3:** In App topbar, replace with `<ConnectBar {...} />`.
- [ ] **Step 4:** `npx tsc --noEmit && npm test && npm run build` — clean / 46 pass / clean.
- [ ] **Step 5:** Commit `refactor(frontend): extract ConnectBar from App`.

---

## Task 3: `Banners`, `Toast`, `StartupModal` (chrome trio)

**Files:** Create `src/components/Banners.tsx`, `Toast.tsx`, `StartupModal.tsx`; Modify `App.tsx`.

- [ ] **Step 1: Interfaces**
```ts
interface BannersProps { handshake: ReturnType<typeof checkHandshake> | null; faulted: boolean; ctrl: Snapshot | undefined; }
interface ToastProps { toast: { msg: string; tone: "ok" | "err" | "warn" } | null; }
interface StartupModalProps { open: boolean; onClose: () => void; }
```
- [ ] **Step 2:** Move `App.tsx:853-866` → `Banners`; `App.tsx:1978` → `Toast`; `App.tsx:1980-2013` → `StartupModal` (its `onClose` = `() => setShowStartup(false)`). Verbatim markup.
- [ ] **Step 3:** Wire `<Banners …/>` (after topbar), `<Toast toast={toast}/>`, `<StartupModal open={showStartup} onClose={() => setShowStartup(false)}/>`.
- [ ] **Step 4:** gate. **Step 5:** Commit `refactor(frontend): extract Banners/Toast/StartupModal`.

---

## Task 4: `TelemetryPanel`

**Files:** Create `src/components/TelemetryPanel.tsx`; Modify `App.tsx` (`<h2>Telemetry</h2>` section, `App.tsx:874-955`).

- [ ] **Step 1: Interface**
```ts
interface TelemetryPanelProps {
  showGauges: boolean; toggleGauges: (on: boolean) => void;
  ramp: RampStatus | undefined; requested: number | null; t: Telemetry | null;
  powerCeil: number; maxRefl: number; fwdCaution: number | null; fwdDanger: number | null; zone: string;
}
```
- [ ] **Step 2:** Move `App.tsx:874-955` verbatim (uses `Gauge`, `StatusLeds`, `fmtWatts` — import them in the component).
- [ ] **Step 3:** `<TelemetryPanel {...} />`. **Step 4:** gate. **Step 5:** Commit.

---

## Task 5: `RfPowerPanel` — WORKED EXAMPLE (the full pattern)

The RF power section (`App.tsx:957-1104`, `<div className="power-row">`) holds the E-STOP/ARM/RF cluster, the setpoint entry + live nudge, the ramp toggle, and the reverse meter.

**Files:** Create `src/components/RfPowerPanel.tsx`; Modify `src/App.tsx`.

- [ ] **Step 1: Create the component with its full interface**
```ts
import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Limits, RampStatus, Telemetry } from "../lib/telemetry.ts";
import { fmtWatts } from "../lib/format.ts";

const SP_FINE = 5, SP_COARSE = 25; // must match useOperator's nudge steps

interface RfPowerPanelProps {
  connected: boolean; armed: boolean; controllable: boolean; faulted: boolean;
  estop: () => void; armDevice: () => void; disarmDevice: () => void; rfOn: () => void; rfOff: () => void;
  setpointInput: string; setSetpointInput: (v: string) => void;
  applySetpoint: () => void; nudgeSetpoint: (d: number) => void; onSetpointKey: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  limits: Limits | undefined;
  ramp: RampStatus | undefined; rampForm: { rate_w_per_s: string } & Record<string, string>;
  setRampForm: (v: RfPowerPanelProps["rampForm"]) => void; startRamp: () => void; stopRamp: () => void;
  t: Telemetry | null; zone: string; reflFillPct: number; maxRefl: number;
}

export function RfPowerPanel(props: RfPowerPanelProps) {
  // Move App.tsx:958-1103 (the <div className="power-row">…</div>) here verbatim,
  // referencing props.* for every value/handler. SP_FINE/SP_COARSE are local consts (above).
  return ( /* moved JSX */ );
}
```
- [ ] **Step 2: Wire it in App** — replace `App.tsx:957-1104` `<section className="panel"><div className="power-row">…</div></section>` with:
```tsx
<section className="panel">
  <RfPowerPanel
    connected={connected} armed={armed} controllable={controllable} faulted={faulted}
    estop={estop} armDevice={armDevice} disarmDevice={disarmDevice} rfOn={rfOn} rfOff={rfOff}
    setpointInput={setpointInput} setSetpointInput={setSetpointInput}
    applySetpoint={applySetpoint} nudgeSetpoint={nudgeSetpoint} onSetpointKey={onSetpointKey}
    limits={limits} ramp={ramp} rampForm={rampForm} setRampForm={setRampForm}
    startRamp={startRamp} stopRamp={stopRamp}
    t={t} zone={zone} reflFillPct={reflFillPct} maxRefl={maxRefl}
  />
</section>
```
Keep the outer `<section className="panel">` in App if that is where it currently sits, OR move it into the component — **choose: move the `<section className="panel">` wrapper into each panel component** so pages compose bare `<RfPowerPanel/>`. Apply this choice consistently to every panel task.
- [ ] **Step 3:** `npx tsc --noEmit` — clean. Verify `SP_FINE`/`SP_COARSE` equal the hook's.
- [ ] **Step 4:** `npm test && npm run build` — 46 pass / clean.
- [ ] **Step 5:** Commit `refactor(frontend): extract RfPowerPanel from App`.

---

## Task 6: `GeneratorPanel`
**Files:** Create `src/components/GeneratorPanel.tsx`; Modify `App.tsx` (`<h2>Generator</h2>`, `App.tsx:1106-1163`).
- [ ] **Step 1: Interface**
```ts
interface GeneratorPanelProps { t: Telemetry | null; limits: Limits | undefined; device: DeviceInfo | undefined; }
```
(uses `fmtTemp`, `tempBar`, `generatorModes` — import them.)
- [ ] **Step 2:** move verbatim. **Step 3:** `<GeneratorPanel t={t} limits={limits} device={device}/>`. **Step 4:** gate. **Step 5:** commit.

---

## Task 7: `HistoryPanel`
**Files:** Create `src/components/HistoryPanel.tsx`; Modify `App.tsx` (`<h2>History</h2>`, `App.tsx:1165-1183`).
- [ ] **Step 1: Interface**
```ts
interface HistoryPanelProps { plot: { fwd: Point[]; refl: Point[] }; powerCeil: number; }
```
(the reflected ceiling is the module const `REFLECT_PLOT_CEIL = 15` — redefine it as a local const in the component, matching App's value; uses `TimePlot`.)
- [ ] **Step 2:** move verbatim. **Step 3:** `<HistoryPanel plot={plot} powerCeil={powerCeil}/>`. **Step 4:** gate. **Step 5:** commit.

---

## Task 8: `MatchingNetworkPanel`
The densest panel (`App.tsx:1187-1387`): tune + load cap V-input/Set/steppers/slider/readback, MODE seg, preset bank + save. If the file exceeds 400 lines, split a `CapControl` sub-component (one cap row) used twice — decide during extraction.
**Files:** Create `src/components/MatchingNetworkPanel.tsx` (+ optional `CapControl.tsx`); Modify `App.tsx`.
- [ ] **Step 1: Interface**
```ts
interface MatchingNetworkPanelProps {
  controllable: boolean; capBusy: null | "tune" | "load";
  tune: number; load: number; t: Telemetry | null;
  tuneVIn: string; setTuneVIn: (v: string) => void; loadVIn: string; setLoadVIn: (v: string) => void;
  applyTuneVolts: () => void; applyLoadVolts: () => void;
  sendTune: (v: number) => void; sendLoad: (v: number) => void; bumpTune: (d: number) => void; bumpLoad: (d: number) => void;
  activeCap: "tune" | "load"; setActiveCap: (c: "tune" | "load") => void; bumpActive: (d: number) => void;
  presets: PresetsStatus | undefined; presetEntries: (readonly [number, PresetSlot])[];
  saveSlot: string; setSaveSlot: (v: string) => void;
  savePreset: (n: number) => void; clearPreset: (n: number) => void; recallPreset: (n: number) => void;
}
```
(uses `capVolts`, `TUNE_CAL`, `LOAD_CAL` — import them.)
- [ ] **Step 2:** move `App.tsx:1187-1387` verbatim. **Step 3:** wire `<MatchingNetworkPanel {...} />`. **Step 4:** gate + confirm `MatchingNetworkPanel.tsx` ≤400 lines (split `CapControl` if not). **Step 5:** commit.

---

## Task 9: `MatchTunerPanel`
**Files:** Create `src/components/MatchTunerPanel.tsx`; Modify `App.tsx` (`<h2>Match tuner</h2>`, `App.tsx:1389-1462`).
- [ ] **Step 1: Interface**
```ts
interface MatchTunerPanelProps {
  controllable: boolean; t: Telemetry | null; mt: MatchTunerStatus | undefined;
  setMatchMode: (m: string) => void; startMatchTuner: () => void; stopMatchTuner: () => void;
  armMatchTuner: () => void; disarmMatchTuner: () => void;
  revPct: (f: number | null | undefined) => string; fmtDelta: (d: number) => string;
}
```
- [ ] **Step 2:** move verbatim. **Step 3:** wire. **Step 4:** gate. **Step 5:** commit.

---

## Task 10: `TimerPanel`
**Files:** Create `src/components/TimerPanel.tsx`; Modify `App.tsx` (`<h2>Auto-shutoff timer</h2>`, `App.tsx:1464-1497`).
- [ ] **Step 1: Interface**
```ts
interface TimerPanelProps { controllable: boolean; timer: TimerStatus | undefined; timerMin: string; setTimerMin: (v: string) => void; startTimer: () => void; stopTimer: () => void; }
```
- [ ] **Step 2:** move verbatim. **Step 3:** wire. **Step 4:** gate. **Step 5:** commit.

---

## Task 11: `RecordingPanel`
**Files:** Create `src/components/RecordingPanel.tsx`; Modify `App.tsx` (`<h2>Recording</h2>`, `App.tsx:1499-1543`).
- [ ] **Step 1: Interface**
```ts
interface RecordingPanelProps {
  controllable: boolean; recording: Status["recording"] | undefined; lastRun: string | null;
  runName: string; setRunName: (v: string) => void; flash: (msg: string, tone?: "ok" | "err" | "warn") => void;
  textInputStyle: React.CSSProperties;
}
```
(calls `api.startRecording`, `api.stopRecording`, `api.downloadRecording` directly — import `api` in the component, matching App's current direct calls.)
- [ ] **Step 2:** move verbatim. **Step 3:** wire. **Step 4:** gate. **Step 5:** commit.

---

## Task 12: Settings panels — `SafetyLimitsPanel`, `ThermalPlanPanel`, `LoggingPanel`, `FlirLinkPanel`, `OperatorPanel`
Extract each as its own file + commit (5 commits). Anchors: Safety limits `App.tsx:1549-1612`; Thermal plan `1614-1686`; Logging `1688-1706`; FLIR link `1708-1737`; Operator `1739-1758`.
- [ ] **Step 1: Interfaces**
```ts
interface SafetyLimitsPanelProps { limitsStatus: SafetyLimitsStatus | null; limForm: Record<string, string>; setLimForm: (v: Record<string, string>) => void; saveLimits: () => void; }
interface ThermalPlanPanelProps { thermalPlanStatus: ThermalPlanStatus | null; thermalForm: Record<string, string>; setThermalForm: (v: Record<string, string>) => void; saveThermalPlan: () => void; }
interface LoggingPanelProps { autoLog: boolean; setAutoLog: (v: boolean) => void; }  // keep the inline api.setAutoLog(...) call as-is (import api)
interface FlirLinkPanelProps { flirUrlInput: string; setFlirUrlInput: (v: string) => void; flirEnabled: boolean; flirLast: FlirLink["last_result"] | null; applyFlirUrl: () => void; toggleFlirEnabled: (on: boolean) => void; textInputStyle: React.CSSProperties; }
interface OperatorPanelProps { baseInput: string; setBaseInput: (v: string) => void; applyBase: () => void; textInputStyle: React.CSSProperties; }
```
(`boundHint` is used by the two form panels — import it. `OperatorPanel` renders only in `SITE_MODE` — keep that guard at the call site, exactly as today.)
- [ ] **Step 2:** move each verbatim. **Step 3:** wire each in App's settings view. **Step 4:** gate after each. **Step 5:** commit each (`refactor(frontend): extract <Name>`).

---

## Task 13: `ThermalControlPanel` + `PulsePanel` (Experimental view — unchanged location)
Extract the two Experimental panels **without moving them** (they relocate in Phase 2). Anchors: Thermal control `App.tsx:1764-1912`; Pulse `1914-1970`.
**Files:** Create `src/components/ThermalControlPanel.tsx`, `src/components/PulsePanel.tsx`; Modify `App.tsx`.
- [ ] **Step 1: Interfaces**
```ts
interface ThermalControlPanelProps {
  controllable: boolean; connected: boolean; t: Telemetry | null; thermal: ThermalStatus | undefined;
  thermalMode: "advisory" | "auto"; setThermalMode: (v: "advisory" | "auto") => void;
  thermalFlirUrl: string; setThermalFlirUrl: (v: string) => void;
  startThermal: () => void; stopThermal: () => void; armThermal: () => void; disarmThermal: () => void;
  applyThermalSource: (t: "simulated" | "flir") => void; applyControlRoi: (name: string) => void;
  textInputStyle: React.CSSProperties;
}
interface PulsePanelProps { controllable: boolean; pulse: PulseStatus | undefined; pulseForm: { on_ms: string; off_ms: string; power_w: string }; setPulseForm: (v: PulsePanelProps["pulseForm"]) => void; startPulse: () => void; stopPulse: () => void; }
```
(uses `fmtTemp`, `fmtWatts` — import them.)
- [ ] **Step 2:** move verbatim. **Step 3:** wire both in App's experimental view. **Step 4:** gate. **Step 5:** commit.

---

## Task 14: Extract the three pages; make `App` a thin shell

**Files:** Create `src/pages/DashboardPage.tsx`, `SettingsPage.tsx`, `ExperimentalPage.tsx`; Modify `src/App.tsx`.

- [ ] **Step 1: Page components take `op: Operator`**
Each page destructures the props it needs from `op` and renders the extracted panels in the **same order and same `.main`/`.col` structure** as today. Example:
```tsx
import type { Operator } from "../hooks/useOperator.ts";
export function DashboardPage({ op }: { op: Operator }) {
  return (
    <div className="main">
      <div className="col">
        <TelemetryPanel showGauges={op.showGauges} toggleGauges={op.toggleGauges} ramp={op.ramp}
          requested={op.requested} t={op.t} powerCeil={op.powerCeil} maxRefl={op.maxRefl}
          fwdCaution={op.fwdCaution} fwdDanger={op.fwdDanger} zone={op.zone} />
        <RfPowerPanel {/* …exactly the props from Task 5… */} />
        <GeneratorPanel t={op.t} limits={op.limits} device={op.device} />
        <HistoryPanel plot={op.plot} powerCeil={op.powerCeil} />
      </div>
      <div className="col">
        <MatchingNetworkPanel {/* …Task 8 props… */} />
        <MatchTunerPanel {/* …Task 9… */} />
        <TimerPanel {/* …Task 10… */} />
        <RecordingPanel {/* …Task 11… */} />
      </div>
    </div>
  );
}
```
`SettingsPage` renders the Task-12 panels in the same `.main`/`.col` order (Operator only in `SITE_MODE`). `ExperimentalPage` renders `ThermalControlPanel` then `PulsePanel` in one `.main` `.col`.

- [ ] **Step 2: App becomes the shell**
```tsx
export function App() {
  const op = useOperator();
  return (
    <div className={`app ${op.showHelp ? "" : "help-off"}`}>
      <header className="topbar">{/* brand, device, viewtabs, help-toggle, <ConnectBar/> */}</header>
      <Banners handshake={op.handshake} faulted={op.faulted} ctrl={op.ctrl} />
      <ErrorBoundary key={op.view}>
        {() => (
          op.view === "dashboard" ? <DashboardPage op={op} />
          : op.view === "settings" ? <SettingsPage op={op} />
          : <ExperimentalPage op={op} />
        )}
      </ErrorBoundary>
      <Toast toast={op.toast} />
      <StartupModal open={op.showStartup} onClose={() => op.setShowStartup(false)} />
    </div>
  );
}
```
Keep the topbar markup (brand/device/viewtabs/help-toggle) inline in App — it is the shell. The `ErrorBoundary key={view}` render-prop wrapper is preserved exactly.

- [ ] **Step 3:** `npx tsc --noEmit && npm test && npm run build` — clean / 46 / clean. Confirm `App.tsx` is now ~90 lines.
- [ ] **Step 4: FINAL MILESTONE visual A/B** — Dashboard / Settings / Experimental (+ gauges-on, connect popover, startup modal) pixel-identical to the Task-0 baselines in real Chrome.
- [ ] **Step 5:** Commit `refactor(frontend): compose App from DashboardPage/SettingsPage/ExperimentalPage`.

---

## Task 15: Verify every file ≤400 lines; split `useOperator` if needed

- [ ] **Step 1:** `find frontend/src -name '*.ts*' -not -name '*.test.ts' | xargs wc -l | sort -rn | head`. Every non-test file must be ≤400.
- [ ] **Step 2:** If `useOperator.ts` >400, split cohesive concerns into sub-hooks in `src/hooks/`: `useTelemetrySocket.ts` (WS + `fwdBuf`/`reflBuf` + `plot` + `capReadRef` mirror), `useConfigSync.ts` (flir-link/limits/thermal-plan/ramp/auto-log load + poll), `useCapControl.ts` (`tune`/`load`/`capBusy`/`waitCapSettle`/`applyCapVolts`/steppers/presets), `useThermalControls.ts` (thermal + pulse handlers). `useOperator` calls them in a FIXED order and spreads their returns. Pass shared deps (`flash`, `controllable`, `t`, `api`) as arguments — do not duplicate state.
- [ ] **Step 3:** After each split: `npx tsc --noEmit && npm test && npm run build`; spot-check the app in Chrome (WS still connects once; caps/config still load).
- [ ] **Step 4:** Commit each split (`refactor(frontend): split useTelemetrySocket out of useOperator`, etc.).
- [ ] **Step 5:** If `MatchingNetworkPanel.tsx` was still >400 after Task 8, split `CapControl` now and commit.

---

## Self-Review (done while writing — recorded here)

- **Spec coverage:** Spec §"Phase 1" (useOperator hook, presentational panels, DashboardPage/SettingsPage, App≤~80 lines, ≤400-line files, gate = tsc+46+build+pixel A/B) → Tasks 1, 2–13, 14, 15, and the Conventions gate. Experimental panels are extracted-in-place (Task 13) so PULSE relocation stays a Phase-2 concern — matches the spec's "PULSE folds into Settings" being Phase 2.
- **Placeholder scan:** No "TBD/handle-edge-cases". The only "choose during extraction" is the `MatchingNetworkPanel`/`CapControl` split, which is a concrete size-driven decision with a stated trigger (>400 lines) and action.
- **Type consistency:** The `Operator` interface (Task 1) is the single source; every panel interface uses a subset of those exact names/types (`controllable`, `t: Telemetry | null`, `capBusy: null | "tune" | "load"`, `presetEntries`, etc.). `SP_FINE`/`SP_COARSE` are flagged to match between hook and `RfPowerPanel`. `REFLECT_PLOT_CEIL` flagged to match between App and `HistoryPanel`.
- **Decision locked:** every panel component owns its own `<section className="panel">` wrapper (Task 5 Step 2) so pages compose bare panels — applied uniformly.

---

## Notes for the executor
- **No behavior change is the whole point.** If a task tempts you to "improve" logic, copy, or a `disabled=` condition — don't. That is Phase 2's job, and drift will fail the pixel A/B.
- Do not restart the operator (`launchctl kickstart`) for these frontend-only changes; `npm run build` + the served `dist` (or a Vite dev preview) is enough for verification. Confirm with Matt before any restart.
- Never enable RF or actuate hardware during verification.
