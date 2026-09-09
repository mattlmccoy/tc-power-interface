// Operator state hook: owns the telemetry WebSocket, config sync, live plot buffers, and every
// control handler for the T&C Power Interface. Extracted verbatim from App.tsx so the Dashboard and
// Closed-loop pages share ONE live operator state — the hook is called once at the top of App, which
// keeps the WebSocket a singleton across renders and page switches.

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";

import { api, detail, operatorBase, setOperatorBase } from "../lib/api.ts";
import type { FlirLink, Health, SerialPort } from "../lib/api.ts";
import { reflectedZone } from "../lib/format.ts";
import { approachFromBelow, capPercentForVolts, capSettled, clampCap, LOAD_CAL, stepSetpoint, TUNE_CAL } from "../lib/instrument.ts";
import { checkHandshake, UI_API_VERSION, wsUrl } from "../lib/operator.ts";
import {
  LIMITS_KEY,
  loadSettings,
  settingsStorage,
  storeSettings,
  THERMAL_KEY,
} from "../lib/settings_store.ts";
import { TraceBuffer } from "../lib/telemetry.ts";
import type {
  Point,
  SafetyLimitsForm,
  SafetyLimitsStatus,
  Status,
  ThermalPlanForm,
  ThermalPlanStatus,
} from "../lib/telemetry.ts";

const FLIR_POLL_MS = 3000;
const SP_FINE = 5; // live power nudge: fine step (W) — ↑/↓ and the ±5 buttons
const SP_COARSE = 25; // live power nudge: coarse step (W) — Shift+↑/↓ and the ±25 buttons

export function useOperator() {
  const [status, setStatus] = useState<Status | null>(null);
  // `reachable` = the operator's WebSocket is open (we can talk to it). `connected` (derived below)
  // additionally requires a device to be attached — with idle boot the operator is reachable long
  // before any generator is connected.
  const [reachable, setReachable] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" | "warn" } | null>(null);
  const [view, setView] = useState<"dashboard" | "settings" | "closed-loop">("dashboard");
  const [showGauges, setShowGauges] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tcp.gauges") === "1";
    } catch {
      return false;
    }
  });
  const toggleGauges = (on: boolean) => {
    setShowGauges(on);
    try {
      localStorage.setItem("tcp.gauges", on ? "1" : "0");
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  };
  // Hero overlay: faint traces of the OTHER live ROIs (caps, powder, electrodes), OFF by default.
  const [showRoiOverlay, setShowRoiOverlay] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tcp.hero.overlay") === "1";
    } catch {
      return false;
    }
  });
  const toggleRoiOverlay = (on: boolean) => {
    setShowRoiOverlay(on);
    try {
      localStorage.setItem("tcp.hero.overlay", on ? "1" : "0");
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  };
  // Explanatory help text is hidden by default (instrument view stays uncluttered); toggle it on.
  const [showHelp, setShowHelp] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tcp.help") === "1";
    } catch {
      return false;
    }
  });
  const toggleHelp = () => {
    setShowHelp((v) => {
      const next = !v;
      try {
        localStorage.setItem("tcp.help", next ? "1" : "0");
      } catch {
        /* storage unavailable — keep in-memory only */
      }
      return next;
    });
  };
  const [showStartup, setShowStartup] = useState(true); // startup-order popup, every boot
  const [setpointInput, setSetpointInput] = useState("100");
  // The commanded setpoint as a SYNCHRONOUS number (React state lags a render, so back-to-back live
  // nudges would read a stale value and under-count). nudge reads/writes this ref; it tracks typing
  // and the server's clamp so every source stays in sync.
  const setpointRef = useRef(100);
  const [rampForm, setRampForm] = useState({ init_w: "0", target_w: "200", rate_w_per_s: "10" });
  const [timerMin, setTimerMin] = useState("30");
  const [saveSlot, setSaveSlot] = useState("1");
  const [activeCap, setActiveCap] = useState<"tune" | "load">("tune");
  const [pulseForm, setPulseForm] = useState({ on_ms: "1000", off_ms: "1000", power_w: "100" });
  const [tune, setTune] = useState(50);
  const [load, setLoad] = useState(50);
  // When did the operator last drive a cap from software? While recent, the display holds their
  // value; otherwise the input/slider MIRROR the device's actual cap position (the AIT is tuned
  // physically/analog, so the readback is the truth — the UI must show where the caps really are).
  const capsTouchedAt = useRef(0);
  // Live cap readback (kept in a ref so the backlash-comp Set can POLL the freshest device position
  // from inside an async handler — React state is a stale snapshot inside a closure).
  const capReadRef = useRef<{ tune: number | null; load: number | null }>({ tune: null, load: null });
  // Which cap (if any) is mid backlash-compensated Set — gates the Set buttons/inputs so a second
  // press can't interleave with the two-step motion on a live matching network.
  const [capBusy, setCapBusy] = useState<null | "tune" | "load">(null);
  const [runName, setRunName] = useState("");
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [autoLog, setAutoLog] = useState(true);
  const [plot, setPlot] = useState<{ fwd: Point[]; refl: Point[] }>({ fwd: [], refl: [] });
  // Closed-loop hero history: control-ROI mean_c, its max_c, and the target, plus the other ROIs.
  const [heroTrace, setHeroTrace] = useState<{ control: Point[]; max: Point[]; target: Point[] }>({
    control: [],
    max: [],
    target: [],
  });
  const [roiTrace, setRoiTrace] = useState<{ name: string; points: Point[] }[]>([]);
  const [base, setBase] = useState(operatorBase());
  const [baseInput, setBaseInput] = useState(operatorBase());
  const [flirUrlInput, setFlirUrlInput] = useState("");
  const [flirEnabled, setFlirEnabled] = useState(false);
  const [flirLast, setFlirLast] = useState<FlirLink["last_result"] | null>(null);
  const [limitsStatus, setLimitsStatus] = useState<SafetyLimitsStatus | null>(null);
  const [limForm, setLimForm] = useState({
    max_forward_w: "",
    max_reflected_w: "",
    temperature_c_trip: "",
    forward_caution_w: "",
    forward_danger_w: "",
  });
  const [thermalPlanStatus, setThermalPlanStatus] = useState<ThermalPlanStatus | null>(null);
  const [thermalForm, setThermalForm] = useState({
    target_c: "",
    soak_s: "",
    approach_band_c: "",
    loop_ceiling_w: "",
    max_step_w: "",
    done_below_c: "",
  });
  const [thermalMode, setThermalMode] = useState<"advisory" | "auto">("advisory");
  const [thermalFlirUrl, setThermalFlirUrl] = useState("");

  const fwdBuf = useRef(new TraceBuffer(150));
  const reflBuf = useRef(new TraceBuffer(150));
  const heroBuf = useRef({
    control: new TraceBuffer(300),
    max: new TraceBuffer(300),
    target: new TraceBuffer(300),
  });
  const roiBufs = useRef(new Map<string, TraceBuffer>());
  const store = settingsStorage();

  const applyBase = () => {
    setOperatorBase(baseInput);
    setBase(operatorBase());
    setBaseInput(operatorBase());
  };

  // Connect popover: operator address + runtime device discovery/connect (mirrors FLIR's setup).
  const [showConnect, setShowConnect] = useState(false);
  const [ports, setPorts] = useState<SerialPort[] | null>(null);
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const [connectErr, setConnectErr] = useState<string | null>(null);
  async function scanPorts() {
    setConnectBusy("scanning");
    setConnectErr(null);
    try {
      setPorts((await api.discovery()).ports);
    } catch {
      setConnectErr("could not reach the operator — check the address above");
      setPorts(null);
    } finally {
      setConnectBusy(null);
    }
  }
  async function connectPort(port: string) {
    setConnectBusy(port);
    setConnectErr(null);
    try {
      const res = await api.connect("serial", port);
      if (res.ok) {
        setShowConnect(false);
      } else {
        setConnectErr(await detail(res));
      }
    } catch {
      setConnectErr("could not reach the operator — check the address above");
    } finally {
      setConnectBusy(null);
    }
  }
  async function disconnectDevice() {
    setConnectBusy("disconnect");
    setConnectErr(null);
    try {
      await api.disconnect();
    } catch {
      /* operator unreachable — nothing to disconnect */
    } finally {
      setConnectBusy(null);
    }
  }
  async function armDevice() {
    const res = await api.arm();
    if (res.ok) flash("armed — control unlocked", "ok");
    else flash("arm failed: " + (await detail(res)));
  }
  async function disarmDevice() {
    await api.disarm();
    flash("disarmed — RF off, read-only", "warn");
  }

  const fillLimForm = (s: SafetyLimitsStatus) => {
    setLimitsStatus(s);
    setLimForm({
      max_forward_w: String(s.max_forward_w),
      max_reflected_w: String(s.max_reflected_w),
      temperature_c_trip: String(s.temperature_c_trip),
      forward_caution_w: String(s.forward_caution_w),
      forward_danger_w: String(s.forward_danger_w),
    });
  };

  const fillThermalForm = (s: ThermalPlanStatus) => {
    setThermalPlanStatus(s);
    setThermalForm({
      target_c: String(s.target_c),
      soak_s: String(s.soak_s),
      approach_band_c: String(s.approach_band_c),
      loop_ceiling_w: String(s.loop_ceiling_w),
      max_step_w: String(s.max_step_w),
      done_below_c: String(s.done_below_c),
    });
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(wsUrl(base, "/ws/telemetry"));
      ws.onopen = () => setReachable(true);
      ws.onmessage = (ev) => {
        const s = JSON.parse(ev.data) as Status;
        setStatus(s);
        if (s.recording?.run) setLastRun(s.recording.run);
        const tel = s.controller.telemetry;
        if (tel) {
          capReadRef.current = { tune: tel.tune_cap_percent ?? null, load: tel.load_cap_percent ?? null };
          const ts = tel.host_timestamp_ns / 1e9;
          fwdBuf.current.push(ts, tel.forward_w);
          reflBuf.current.push(ts, tel.reflected_fraction * 100);
          setPlot({ fwd: fwdBuf.current.toArray(), refl: reflBuf.current.toArray() });
        }
        // Hero trace history — only while the loop runs, so a stopped loop never accrues a flat line.
        const th = s.thermal;
        if (th?.running) {
          const hts = Date.now() / 1000;
          heroBuf.current.control.push(hts, th.control_temp_c);
          if (th.control_max_c != null) heroBuf.current.max.push(hts, th.control_max_c);
          heroBuf.current.target.push(hts, th.target_c);
          for (const r of th.roi_temps ?? []) {
            if (r.mean_c == null) continue;
            let b = roiBufs.current.get(r.name);
            if (!b) {
              b = new TraceBuffer(300);
              roiBufs.current.set(r.name, b);
            }
            b.push(hts, r.mean_c);
          }
          setHeroTrace({
            control: heroBuf.current.control.toArray(),
            max: heroBuf.current.max.toArray(),
            target: heroBuf.current.target.toArray(),
          });
          setRoiTrace(
            [...roiBufs.current.entries()].map(([name, b]) => ({ name, points: b.toArray() })),
          );
        }
      };
      ws.onclose = () => {
        setReachable(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [base]);

  // Fetch the operator's version/API each time it becomes reachable (for the handshake + display).
  useEffect(() => {
    if (!reachable) {
      setHealth(null);
      return;
    }
    let alive = true;
    api
      .health()
      .then((h) => alive && setHealth(h))
      .catch(() => alive && setHealth(null));
    return () => {
      alive = false;
    };
  }, [reachable, base]);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async () => {
      try {
        const link = await api.flirLink();
        if (!cancelled) {
          setFlirUrlInput(link.url);
          setFlirEnabled(link.enabled);
          setFlirLast(link.last_result);
        }
      } catch {
        /* operator unreachable — keep last known */
      }
      // Safety limits: prefer the operator, but auto-apply any offline-saved (pending) local values,
      // and fall back to showing local values when the operator is unreachable.
      const localLim = loadSettings<SafetyLimitsForm>(store, LIMITS_KEY);
      try {
        const lim = await api.safetyLimits();
        if (cancelled) return;
        if (localLim?.pending) {
          const res = await api.saveSafetyLimits(localLim.v);
          if (res.ok) {
            storeSettings(store, LIMITS_KEY, { v: localLim.v, pending: false });
            fillLimForm((await res.json()) as SafetyLimitsStatus);
          } else {
            fillLimForm(lim);
          }
        } else {
          fillLimForm(lim);
        }
      } catch {
        if (!cancelled && localLim) fillLimForm({ ...localLim.v, bounds: {} });
      }
      const localTp = loadSettings<ThermalPlanForm>(store, THERMAL_KEY);
      try {
        const tp = await api.thermalPlan();
        if (cancelled) return;
        if (localTp?.pending) {
          const res = await api.saveThermalPlan(localTp.v);
          if (res.ok) {
            storeSettings(store, THERMAL_KEY, { v: localTp.v, pending: false });
            fillThermalForm((await res.json()) as ThermalPlanStatus);
          } else {
            fillThermalForm(tp);
          }
        } else {
          fillThermalForm(tp);
        }
      } catch {
        if (!cancelled && localTp) fillThermalForm({ ...localTp.v, bounds: {} });
      }
      try {
        const al = await api.autoLog();
        if (!cancelled) setAutoLog(al.enabled);
      } catch {
        /* keep last known */
      }
      try {
        const rc = await api.ramp();
        if (!cancelled)
          setRampForm({
            init_w: String(rc.init_w),
            target_w: String(rc.target_w),
            rate_w_per_s: String(rc.rate_w_per_s),
          });
      } catch {
        /* keep last known */
      }
    };
    loadConfig();
    const poll = setInterval(async () => {
      try {
        const link = await api.flirLink();
        if (!cancelled) setFlirLast(link.last_result);
      } catch {
        /* transient */
      }
    }, FLIR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [base]);

  // tone drives the toast colour: "ok" green (affirmative), "err" red (failures — the default so a
  // missed tag never dresses an error up as success), "warn" amber (e.g. E-STOP confirmation).
  const flash = (msg: string, tone: "ok" | "err" | "warn" = "err") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  const ctrl = status?.controller;
  const t = ctrl?.telemetry ?? null;
  const limits = ctrl?.limits;
  const device = status?.device;
  const recording = status?.recording;
  const thermal = status?.thermal;
  const ramp = status?.ramp;
  const timer = status?.timer;
  const presets = status?.presets;
  const presetEntries = presets
    ? Object.entries(presets.slots)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [Number(k), v as NonNullable<typeof v>] as const)
        .sort((a, b) => a[0] - b[0])
    : [];
  const pulse = status?.pulse;
  const mt = status?.match_tuner;
  const revPct = (f: number | null | undefined): string =>
    f == null ? "—" : `${(f * 100).toFixed(1)}%`;
  const fmtDelta = (d: number): string => `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
  const state = ctrl?.state ?? "disconnected";
  // A device is usable only when the operator is reachable AND a generator is attached (CONNECTED).
  // FAULT still counts as connected (a device is there) so fault handling/controls behave.
  const connected = reachable && (state === "connected" || state === "fault");
  // A connected device is read-only until ARMED. `controllable` gates every command that changes the
  // generator (RF on, setpoint, caps, ramp/pulse/thermal/timer/tuner). RF OFF, E-STOP and DISARM stay
  // available whenever connected — they are the safe-direction actions.
  const armed = connected && (ctrl?.armed ?? false);
  const controllable = connected && armed;
  const pillState = !reachable || state === "disconnected"
    ? "disconnected"
    : state === "fault"
      ? "fault"
      : "connected";
  // UI ↔ operator API version handshake (like FLIR): major mismatch refuses, minor warns.
  const handshake = reachable && health ? checkHandshake(UI_API_VERSION, health.api_version) : null;
  const faulted = state === "fault";

  // Mirror the device's ACTUAL cap positions into the input/slider (unless the operator drove a cap
  // from software within the last 1.5 s). The AIT is tuned physically, so the readback is the truth
  // — the UI must show where the caps really are, not a stale default. setTune/setLoad to an equal
  // value is a no-op, so this can run every telemetry tick without looping.
  useEffect(() => {
    if (!connected || Date.now() - capsTouchedAt.current < 1500) return;
    if (t?.tune_cap_percent != null) setTune(clampCap(t.tune_cap_percent));
    if (t?.load_cap_percent != null) setLoad(clampCap(t.load_cap_percent));
  }, [t?.tune_cap_percent, t?.load_cap_percent, connected]);
  const maxRefl = limits?.max_reflected_w ?? 25;
  const reflW = t?.reverse_w ?? 0;
  const zone = t ? reflectedZone(reflW, maxRefl * 0.5, maxRefl) : "ok";
  const reflFillPct = Math.min(100, (reflW / maxRefl) * 100);
  const powerCeil = device?.power_limit_w ?? 600;
  const fwdCaution = limits?.forward_caution_w ?? null;
  const fwdDanger = limits?.forward_danger_w ?? null;
  const requested = Number.isNaN(Number(setpointInput)) ? null : Number(setpointInput);

  async function rfOn() {
    if (!window.confirm("Enable RF output now? The generator will begin delivering power.")) return;
    const res = await api.rfEnable();
    if (!res.ok) flash("RF enable refused: " + (await detail(res)));
  }
  async function rfOff() {
    await api.rfDisable();
  }
  async function estop() {
    await api.estop();
    flash("E-STOP — RF off, setpoint 0, all drivers halted", "warn");
  }
  // Send a forward-power setpoint and reflect what the server actually applied. The input jumps to
  // the requested value immediately (so the live −/+ feels responsive), then corrects to applied_w
  // only if the server clamped. `announce` gives the explicit Apply a confirmation toast; the live
  // nudges stay quiet on success (a toast per click would be noise) but still warn on a clamp/error.
  async function sendSetpoint(watts: number, announce: boolean) {
    setpointRef.current = watts; // synchronous, so a fast follow-up nudge reads this, not stale state
    setSetpointInput(String(watts));
    const res = await api.setSetpoint(watts);
    if (!res.ok) {
      flash(await detail(res));
      return;
    }
    const j = await res.json();
    if (j.applied_w !== watts) {
      setpointRef.current = j.applied_w;
      setSetpointInput(String(j.applied_w));
      flash(`setpoint clamped to ${j.applied_w} W`, "warn");
    } else if (announce) {
      flash(`setpoint applied: ${j.applied_w} W`, "ok");
    }
  }
  async function applySetpoint() {
    const watts = Number(setpointInput);
    if (Number.isNaN(watts)) return flash("setpoint must be a number");
    await sendSetpoint(Math.round(watts), true);
  }
  // Live power nudge: no Apply — each press sends instantly, clamped to the forward-power ceiling.
  // Only when controllable (armed + connected). SP_FINE/SP_COARSE are the fine/coarse step sizes.
  function nudgeSetpoint(delta: number) {
    if (!controllable) return;
    const next = stepSetpoint(setpointRef.current, delta, limits?.max_forward_w ?? Number.NaN);
    void sendSetpoint(next, false);
  }
  // Keyboard on the setpoint field: ↑/↓ nudge by the fine step, Shift+↑/↓ by the coarse step, Enter
  // applies. preventDefault stops the number input's native ±1 step (which would bypass the send).
  function onSetpointKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = e.shiftKey ? SP_COARSE : SP_FINE;
      nudgeSetpoint(e.key === "ArrowUp" ? step : -step);
    } else if (e.key === "Enter") {
      void applySetpoint();
    }
  }
  async function startRamp() {
    // Ramp is always 0 -> the current forward-power setpoint, at the chosen rate.
    const rate = Number(rampForm.rate_w_per_s);
    const target = Number(setpointInput);
    if (Number.isNaN(rate) || Number.isNaN(target)) return flash("ramp rate / setpoint must be numbers");
    await api.saveRamp({ init_w: 0, target_w: target, rate_w_per_s: rate });
    const res = await api.rampStart();
    if (!res.ok) flash("ramp start failed: " + (await detail(res)));
  }
  async function stopRamp() {
    await api.rampStop();
  }
  async function startTimer() {
    const m = Number(timerMin);
    if (Number.isNaN(m)) return flash("timer minutes must be a number");
    await api.saveTimer(m);
    await api.timerStart();
  }
  async function stopTimer() {
    await api.timerStop();
  }
  async function savePreset(slot: number) {
    await api.presetSave(slot, tune, load);
  }
  async function clearPreset(slot: number) {
    await api.presetDelete(slot);
  }
  async function recallPreset(slot: number) {
    const res = await api.presetRecall(slot);
    if (!res.ok) return flash("recall failed: " + (await detail(res)));
    const applied = (await res.json())?.applied;
    if (applied) {
      setTune(applied.tune_cap_percent);
      setLoad(applied.load_cap_percent);
    }
  }
  async function startPulse() {
    const on = Number(pulseForm.on_ms);
    const off = Number(pulseForm.off_ms);
    const pw = Number(pulseForm.power_w);
    if ([on, off, pw].some((n) => Number.isNaN(n))) return flash("pulse values must be numbers");
    await api.savePulse(on, off, pw);
    await api.pulseStart();
  }
  // Software matching auto-tuner. The panel only exposes advisory/auto + start/arm; the step/guard
  // tuning keeps the server defaults. It NEVER enables RF and only drives caps when armed in auto.
  async function setMatchMode(mode: string) {
    await api.saveMatchTuner({ mode, tune_step: 1.0, load_step: 0.3, guard: 0.6 });
  }
  async function startMatchTuner() {
    await api.matchTunerStart();
  }
  async function stopMatchTuner() {
    await api.matchTunerStop();
  }
  async function armMatchTuner() {
    await api.matchTunerArm();
  }
  async function disarmMatchTuner() {
    await api.matchTunerDisarm();
  }
  async function stopPulse() {
    await api.pulseStop();
  }
  async function sendTune(v: number) {
    capsTouchedAt.current = Date.now();
    setTune(v);
    await api.tune(v);
  }
  async function sendLoad(v: number) {
    capsTouchedAt.current = Date.now();
    setLoad(v);
    await api.load(v);
  }
  // Cap steppers are single-click, 1% each (the generator's real resolution). No hold-to-repeat:
  // an auto-repeating cap stepper is a hazard on a live matching network.
  const bumpTune = (d: number) => sendTune(clampCap(tune + d));
  const bumpLoad = (d: number) => sendLoad(clampCap(load + d));
  const bumpActive = (d: number) => (activeCap === "tune" ? bumpTune(d) : bumpLoad(d));

  // Voltage-driven cap tuning: type the target control voltage from the VNA, snap to the nearest
  // whole percent (the generator's real resolution). Cleared after apply.
  const [tuneVIn, setTuneVIn] = useState("");
  const [loadVIn, setLoadVIn] = useState("");
  // Poll the LIVE device readback (via capReadRef) until the named cap has reached `target` within
  // `tol` whole percent, or `timeoutMs` elapses. The AIT motor is slow — this waits it out between
  // the two steps of an approach-from-below so the final motion is genuinely upward.
  function waitCapSettle(which: "tune" | "load", target: number, tol = 2, timeoutMs = 12000): Promise<void> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (capSettled(capReadRef.current[which], target, tol) || Date.now() - t0 >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }
  // Backlash-compensated Set: land the cap on the target from BELOW. The AIT has mechanical backlash,
  // so the %↔V map is a hysteresis loop — approaching from above vs below lands at a slightly
  // different voltage (measured ~+0.8% vs +0.2% off). Matt swept the calibration going UP, so we
  // finish going UP: overshoot to target−margin, wait for the motor to reach it, then step up to the
  // target. capBusy gates re-entry so a second press can't interleave with the motion.
  async function applyCapVolts(which: "tune" | "load", vin: string, cal: typeof TUNE_CAL): Promise<void> {
    const v = Number(vin);
    if (Number.isNaN(v) || vin.trim() === "") return flash(`enter a ${which} voltage`);
    if (capBusy) return; // a Set is already in flight
    const send = which === "tune" ? sendTune : sendLoad;
    const setVin = which === "tune" ? setTuneVIn : setLoadVIn;
    const [pre, target] = approachFromBelow(capPercentForVolts(v, cal));
    setVin("");
    setCapBusy(which);
    try {
      await send(pre); // step 1: drop below the target (takes up backlash in the down direction)
      await waitCapSettle(which, pre); // wait out the slow motor
      await send(target); // step 2: finish UP onto the target
    } catch {
      flash(`${which} cap set failed`);
    } finally {
      setCapBusy(null);
    }
  }
  const applyTuneVolts = () => void applyCapVolts("tune", tuneVIn, TUNE_CAL);
  const applyLoadVolts = () => void applyCapVolts("load", loadVIn, LOAD_CAL);
  async function applyFlirLink(url: string, enabled: boolean) {
    try {
      const res = await api.setFlirLink(url.trim(), enabled);
      if (res.ok) {
        const link = (await res.json()) as FlirLink;
        setFlirUrlInput(link.url);
        setFlirEnabled(link.enabled);
        setFlirLast(link.last_result);
      } else {
        flash("FLIR link update failed: " + (await detail(res)));
      }
    } catch {
      flash("FLIR link update failed: could not reach operator");
    }
  }
  function applyFlirUrl() {
    applyFlirLink(flirUrlInput, flirEnabled);
  }
  function toggleFlirEnabled(on: boolean) {
    setFlirEnabled(on);
    applyFlirLink(flirUrlInput, on);
  }
  async function saveLimits() {
    const body = {
      max_forward_w: Number(limForm.max_forward_w),
      max_reflected_w: Number(limForm.max_reflected_w),
      temperature_c_trip: Number(limForm.temperature_c_trip),
      forward_caution_w: Number(limForm.forward_caution_w),
      forward_danger_w: Number(limForm.forward_danger_w),
    };
    if (Object.values(body).some((n) => Number.isNaN(n))) return flash("limits must be numbers");
    try {
      const res = await api.saveSafetyLimits(body);
      if (res.ok) {
        storeSettings(store, LIMITS_KEY, { v: body, pending: false });
        fillLimForm((await res.json()) as SafetyLimitsStatus);
        flash("safety limits saved", "ok");
      } else {
        flash(await detail(res));
      }
    } catch {
      // Operator unreachable: keep the values locally and apply them on the next connect.
      storeSettings(store, LIMITS_KEY, { v: body, pending: true });
      fillLimForm({ ...body, bounds: limitsStatus?.bounds ?? {} });
      flash("saved locally — will apply when the operator connects", "ok");
    }
  }
  async function saveThermalPlan() {
    const body = {
      target_c: Number(thermalForm.target_c),
      soak_s: Number(thermalForm.soak_s),
      approach_band_c: Number(thermalForm.approach_band_c),
      loop_ceiling_w: Number(thermalForm.loop_ceiling_w),
      max_step_w: Number(thermalForm.max_step_w),
      done_below_c: Number(thermalForm.done_below_c),
    };
    if (Object.values(body).some((n) => Number.isNaN(n))) return flash("thermal plan must be numbers");
    try {
      const res = await api.saveThermalPlan(body);
      if (res.ok) {
        storeSettings(store, THERMAL_KEY, { v: body, pending: false });
        fillThermalForm((await res.json()) as ThermalPlanStatus);
        flash("thermal plan saved", "ok");
      } else {
        flash(await detail(res));
      }
    } catch {
      storeSettings(store, THERMAL_KEY, { v: body, pending: true });
      fillThermalForm({ ...body, bounds: thermalPlanStatus?.bounds ?? {} });
      flash("saved locally — will apply when the operator connects", "ok");
    }
  }
  async function startThermal() {
    const res = await api.thermalStart(thermalMode);
    if (!res.ok) flash("thermal start failed: " + (await detail(res)));
  }
  async function stopThermal() {
    await api.thermalStop();
  }
  async function armThermal() {
    if (
      !window.confirm(
        "Arm the thermal loop to drive the RF setpoint on real hardware? Only do this while you are watching the system.",
      )
    )
      return;
    await api.thermalArm();
  }
  async function disarmThermal() {
    await api.thermalDisarm();
  }
  async function applyThermalSource(type: "simulated" | "flir") {
    const res = await api.thermalSource(type, type === "flir" ? thermalFlirUrl.trim() : undefined);
    if (!res.ok) flash("thermal source failed: " + (await detail(res)));
  }
  async function applyControlRoi(name: string) {
    const res = await api.setThermalRoi(name);
    if (!res.ok) flash("control ROI failed: " + (await detail(res)));
  }

  const textInputStyle = {
    width: "100%",
    background: "var(--bg-deep)",
    border: "1px solid var(--line-control)",
    borderRadius: "var(--radius)",
    padding: "8px 10px",
    marginBottom: "8px",
  } as const;

  return {
    status, reachable, health, toast, flash, view, setView, showGauges, toggleGauges,
    showRoiOverlay, toggleRoiOverlay, heroTrace, roiTrace, showHelp,
    toggleHelp, showStartup, setShowStartup, setpointInput, setSetpointInput, setpointRef,
    applySetpoint, nudgeSetpoint, onSetpointKey, rfOn, rfOff, estop, rampForm, setRampForm,
    startRamp, stopRamp, tune, load, activeCap, setActiveCap, capBusy, tuneVIn, setTuneVIn, loadVIn,
    setLoadVIn, sendTune, sendLoad, bumpTune, bumpLoad, bumpActive, applyTuneVolts, applyLoadVolts,
    saveSlot, setSaveSlot, savePreset, clearPreset, recallPreset, setMatchMode, startMatchTuner,
    stopMatchTuner, armMatchTuner, disarmMatchTuner, revPct, fmtDelta, timerMin, setTimerMin,
    startTimer, stopTimer, runName, setRunName, lastRun, autoLog, setAutoLog, limitsStatus, limForm,
    setLimForm, saveLimits, thermalPlanStatus, thermalForm, setThermalForm, saveThermalPlan,
    flirUrlInput, setFlirUrlInput, flirEnabled, flirLast, applyFlirUrl, toggleFlirEnabled,
    thermalMode, setThermalMode, thermalFlirUrl, setThermalFlirUrl, startThermal, stopThermal,
    armThermal, disarmThermal, applyThermalSource, applyControlRoi, pulseForm, setPulseForm,
    startPulse, stopPulse, plot, ctrl, t, limits, device, recording, thermal, ramp, timer, presets,
    pulse, mt, presetEntries, connected, armed, controllable, faulted, pillState, handshake,
    maxRefl, reflW, zone, reflFillPct, powerCeil, fwdCaution, fwdDanger, requested, textInputStyle,
    base, baseInput, setBaseInput, applyBase, showConnect, setShowConnect, ports, connectBusy,
    connectErr, setPorts, setConnectErr, scanPorts, connectPort, disconnectDevice, armDevice,
    disarmDevice,
  };
}

export type Operator = ReturnType<typeof useOperator>;
