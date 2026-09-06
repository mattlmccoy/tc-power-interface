import { useEffect, useRef, useState } from "react";

import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Gauge } from "./components/Gauge.tsx";
import { StatusLeds } from "./components/StatusLeds.tsx";
import { TimePlot } from "./components/TimePlot.tsx";
import { api, detail, operatorBase, setOperatorBase, SITE_MODE } from "./lib/api.ts";
import type { FlirLink } from "./lib/api.ts";
import { boundHint, flirStatusLabel, fmtTemp, fmtWatts, reflectedZone } from "./lib/format.ts";
import { capVolts, clampCap, generatorModes, LOAD_VOLTS, tempBar, TUNE_VOLTS } from "./lib/instrument.ts";
import { wsUrl } from "./lib/operator.ts";
import {
  LIMITS_KEY,
  loadSettings,
  settingsStorage,
  storeSettings,
  THERMAL_KEY,
} from "./lib/settings_store.ts";
import { TraceBuffer } from "./lib/telemetry.ts";
import type {
  Point,
  SafetyLimitsForm,
  SafetyLimitsStatus,
  Status,
  ThermalPlanForm,
  ThermalPlanStatus,
} from "./lib/telemetry.ts";

const FLIR_POLL_MS = 3000;
const REFLECT_PLOT_CEIL = 15; // history-plot reflected % y-scale

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "settings" | "experimental">("dashboard");
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
  const [showStartup, setShowStartup] = useState(true); // startup-order popup, every boot
  const [setpointInput, setSetpointInput] = useState("100");
  const [rampForm, setRampForm] = useState({ init_w: "0", target_w: "200", rate_w_per_s: "10" });
  const [timerMin, setTimerMin] = useState("30");
  const [saveSlot, setSaveSlot] = useState("1");
  const [activeCap, setActiveCap] = useState<"tune" | "load">("tune");
  const [pulseForm, setPulseForm] = useState({ on_ms: "1000", off_ms: "1000", power_w: "100" });
  const [tune, setTune] = useState(50);
  const [load, setLoad] = useState(50);
  const [runName, setRunName] = useState("");
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [autoLog, setAutoLog] = useState(true);
  const [plot, setPlot] = useState<{ fwd: Point[]; refl: Point[] }>({ fwd: [], refl: [] });
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
  const store = settingsStorage();

  const applyBase = () => {
    setOperatorBase(baseInput);
    setBase(operatorBase());
    setBaseInput(operatorBase());
  };

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
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        const s = JSON.parse(ev.data) as Status;
        setStatus(s);
        if (s.recording?.run) setLastRun(s.recording.run);
        const tel = s.controller.telemetry;
        if (tel) {
          const ts = tel.host_timestamp_ns / 1e9;
          fwdBuf.current.push(ts, tel.forward_w);
          reflBuf.current.push(ts, tel.reflected_fraction * 100);
          setPlot({ fwd: fwdBuf.current.toArray(), refl: reflBuf.current.toArray() });
        }
      };
      ws.onclose = () => {
        setConnected(false);
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

  const flash = (msg: string) => {
    setToast(msg);
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
  const pillState = !connected ? "disconnected" : state === "fault" ? "fault" : "connected";
  const faulted = state === "fault";
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
    flash("E-STOP — RF off, setpoint 0, all drivers halted");
  }
  async function applySetpoint() {
    const watts = Number(setpointInput);
    if (Number.isNaN(watts)) return flash("setpoint must be a number");
    const res = await api.setSetpoint(watts);
    if (res.ok) {
      const j = await res.json();
      flash(`setpoint applied: ${j.applied_w} W${j.applied_w !== watts ? " (clamped)" : ""}`);
    } else {
      flash(await detail(res));
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
    setTune(v);
    await api.tune(v);
  }
  async function sendLoad(v: number) {
    setLoad(v);
    await api.load(v);
  }
  // Fine-adjust steppers: click bumps by 1%, hold auto-repeats.
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRepeat = () => {
    if (repeatRef.current) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  };
  const holdStep = (fn: () => void) => {
    fn();
    stopRepeat();
    repeatRef.current = setInterval(fn, 140);
  };
  const bumpTune = (d: number) => sendTune(clampCap(tune + d));
  const bumpLoad = (d: number) => sendLoad(clampCap(load + d));
  const bumpActive = (d: number) => (activeCap === "tune" ? bumpTune(d) : bumpLoad(d));
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
        flash("safety limits saved");
      } else {
        flash(await detail(res));
      }
    } catch {
      // Operator unreachable: keep the values locally and apply them on the next connect.
      storeSettings(store, LIMITS_KEY, { v: body, pending: true });
      fillLimForm({ ...body, bounds: limitsStatus?.bounds ?? {} });
      flash("saved locally — will apply when the operator connects");
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
        flash("thermal plan saved");
      } else {
        flash(await detail(res));
      }
    } catch {
      storeSettings(store, THERMAL_KEY, { v: body, pending: true });
      fillThermalForm({ ...body, bounds: thermalPlanStatus?.bounds ?? {} });
      flash("saved locally — will apply when the operator connects");
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

  const textInputStyle = {
    width: "100%",
    background: "var(--bg-deep)",
    border: "1px solid var(--line-control)",
    borderRadius: "var(--radius)",
    padding: "8px 10px",
    marginBottom: "8px",
  } as const;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          T<span className="amp">&amp;</span>C Power Interface
        </span>
        <span className="device">
          {device?.id ? `${device.id} · ${device.serial ?? ""}` : "no device"}
          {device?.frequency_hz ? ` · ${(device.frequency_hz / 1e6).toFixed(2)} MHz` : ""}
        </span>
        <span className="spacer" />
        <span className="viewtabs">
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            Dashboard
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            Settings
          </button>
          <button
            className={view === "experimental" ? "active" : ""}
            onClick={() => setView("experimental")}
          >
            Experimental
          </button>
        </span>
        <span className={`pill ${pillState}`}>
          <span className="dot" />
          {pillState}
        </span>
      </header>

      {faulted ? (
        <div className="banner fault">
          <strong>FAULT — RF disabled.</strong> {ctrl?.fault_reasons.join("; ")}
        </div>
      ) : ctrl && ctrl.warnings.length > 0 ? (
        <div className="banner warn">
          <strong>WARNING.</strong> {ctrl.warnings.join("; ")}
        </div>
      ) : null}

      <ErrorBoundary key={view}>
        {() => (
          <>
            {view === "dashboard" ? (
          <div className="main">
          <div className="col">
            <section className="panel">
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <h2 style={{ margin: 0 }}>Telemetry</h2>
                  {ramp?.running ? (
                    <span className="ramp-badge">
                      ▲ R · ramping → {ramp.target_w} W @ {ramp.rate_w_per_s} W/s
                    </span>
                  ) : null}
                </div>
                <label className="toggle" style={{ margin: 0, fontSize: "12px" }}>
                  <input
                    type="checkbox"
                    checked={showGauges}
                    onChange={(e) => toggleGauges(e.target.checked)}
                  />
                  Analog gauges
                </label>
              </div>
              {showGauges ? (
                <div className="gauge-grid" style={{ marginTop: "10px" }}>
                  <Gauge
                    label="Requested"
                    value={requested}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                  <Gauge
                    label="Forward"
                    value={t ? t.forward_w : null}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                  <Gauge
                    label="Reverse"
                    value={t ? t.reverse_w : null}
                    max={powerCeil}
                    caution={maxRefl * 0.5}
                    danger={maxRefl}
                  />
                  <Gauge
                    label="Load"
                    value={t ? t.load_w : null}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                </div>
              ) : (
                <div className="cards" style={{ marginTop: "10px" }}>
                  <div className="readout">
                    <div className="label">Requested</div>
                    <div className="value">{requested === null ? "—" : fmtWatts(requested)}</div>
                  </div>
                  <div className="readout">
                    <div className="label">Forward power</div>
                    <div className={`value ${t?.rf_on ? "rf-on" : ""}`}>
                      {t ? fmtWatts(t.forward_w) : "—"}
                    </div>
                  </div>
                  <div className={`readout zone-${zone}`}>
                    <div className="label">Reverse power</div>
                    <div className="value">{t ? fmtWatts(t.reverse_w) : "—"}</div>
                  </div>
                  <div className="readout">
                    <div className="label">Load power</div>
                    <div className="value">{t ? fmtWatts(t.load_w) : "—"}</div>
                  </div>
                </div>
              )}
              <div style={{ marginTop: "10px" }}>
                <StatusLeds status={t ? t.status : null} />
              </div>
              <div className="hint mono">
                RF {t?.rf_on ? "ON" : "off"} · mode {t?.operation_mode ?? "—"} · tuner{" "}
                {t?.tuner ?? "—"}
              </div>
            </section>

            <section className="panel">
              <div className="power-row">
                <div className="rfcontrol-box">
                  <div className="field-label">RF control</div>
                  <button
                    className="btn estop full"
                    onClick={estop}
                    disabled={!connected}
                    title="Emergency stop: RF off, setpoint 0, all drivers halted"
                  >
                    ⏻ E-STOP
                  </button>
                  <div className="row" style={{ marginTop: "8px" }}>
                    <button
                      className="btn danger full"
                      onClick={rfOn}
                      disabled={!connected || faulted}
                    >
                      RF ON
                    </button>
                    <button className="btn full" onClick={rfOff} disabled={!connected}>
                      RF OFF
                    </button>
                  </div>
                  <div className="hint">
                    {faulted
                      ? "RF-enable blocked while faulted."
                      : "RF-enable prompts to confirm. Protection commands RF off on any trip."}
                  </div>
                </div>
                <div className="setpoint-box">
                  <label className="field-label" htmlFor="sp">
                    Forward power setpoint (W)
                  </label>
                  <div className="row">
                    <input
                      id="sp"
                      type="number"
                      min={0}
                      value={setpointInput}
                      onChange={(e) => setSetpointInput(e.target.value)}
                    />
                    <button className="btn accent" onClick={applySetpoint} disabled={!connected}>
                      Apply
                    </button>
                  </div>
                  <div className="hint">
                    Ceiling {limits?.max_forward_w ?? "—"} W (clamped). Edit in Settings.
                  </div>
                  <div className="setpoint-ramp">
                    <span className="cap-name">Ramp 0→setpoint @</span>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={rampForm.rate_w_per_s}
                      disabled={ramp?.running}
                      onChange={(e) => setRampForm({ ...rampForm, rate_w_per_s: e.target.value })}
                    />
                    <span className="cap-name">W/s</span>
                    {ramp?.running ? (
                      <button className="btn" onClick={stopRamp}>
                        Stop
                      </button>
                    ) : (
                      <button className="btn" onClick={startRamp} disabled={!connected}>
                        Start ramp
                      </button>
                    )}
                  </div>
                  {ramp?.running ? (
                    <div className="hint mono">
                      ▲ ramping {ramp.output_w} → {ramp.target_w} W{ramp.done ? " · reached" : ""}
                    </div>
                  ) : null}
                </div>
                <div className="revmeter-box">
                  <div className="field-label">Reverse power</div>
                  <div className="revmeter">
                    <div className={`revmeter-value zone-${zone}`}>
                      {t ? fmtWatts(t.reverse_w) : "—"}
                    </div>
                    <div className="revmeter-track">
                      <div className={`revmeter-fill ${zone}`} style={{ width: `${reflFillPct}%` }} />
                      <div className="revmeter-mark warn" style={{ left: "50%" }} />
                    </div>
                    <div className="revmeter-legend">
                      warn {(maxRefl * 0.5).toFixed(0)} W · trip {maxRefl.toFixed(0)} W
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel gen-panel">
              <h2>Generator</h2>
              <div className="readout" style={{ marginBottom: "8px" }}>
                <div className="label">Internal temperature</div>
                <div className="temp-row">
                  <div className="value">{t ? fmtTemp(t.temperature_c) : "—"}</div>
                  {t && limits ? (
                    <div className="temp-bar-wrap">
                      <div className="temp-bar">
                        <div
                          className="temp-bar-fill"
                          style={{
                            width: `${tempBar(t.temperature_c, 25, limits.temperature_c_trip).fraction * 100}%`,
                            background: tempBar(t.temperature_c, 25, limits.temperature_c_trip)
                              .color,
                          }}
                        />
                      </div>
                      <div className="temp-bar-legend">
                        <span>25 °C</span>
                        <span>trip {limits.temperature_c_trip.toFixed(0)} °C</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="cards">
                <div className="readout">
                  <div className="label">DC probe (bias)</div>
                  <div className="value">
                    {t?.dc_voltage != null ? `${t.dc_voltage.toFixed(0)} V` : "—"}
                  </div>
                </div>
                <div className="readout">
                  <div className="label">Preset</div>
                  <div className="value">{t?.preset_slot ? `#${t.preset_slot}` : "—"}</div>
                </div>
                <div className="readout">
                  <div className="label">RF source</div>
                  <div className="value">{t ? generatorModes(t.status).rfSource : "—"}</div>
                </div>
                <div className="readout">
                  <div className="label">Leveling</div>
                  <div className="value">{t ? generatorModes(t.status).leveling : "—"}</div>
                </div>
              </div>
              <div className="hint">
                <strong>DC probe</strong> = plasma self-bias measured through the tuner (0–999 V).
                ~0 V is expected here: a dielectric load (powder between plates) is not a plasma, so
                no sheath rectifies a DC self-bias — match quality shows up in forward/reflected
                power, not DC. A nonzero reading would signal arcing or a partial discharge.
              </div>
              <div className="hint">
                Frequency {device?.frequency_hz ? (device.frequency_hz / 1e6).toFixed(2) : "—"} MHz ·
                mode {t?.operation_mode ?? "—"}. Read-only — preset / RF-source / leveling writes need
                the verified CXN command set (deferred; the real unit's CXN support is unconfirmed).
              </div>
            </section>

            <section className="panel">
              <h2>History</h2>
              <TimePlot
                forward={plot.fwd}
                reflectedPct={plot.refl}
                powerCeil={powerCeil}
                reflectCeil={REFLECT_PLOT_CEIL}
              />
              <div className="plot-legend">
                <span>
                  <span className="swatch fwd" />
                  forward power (0–{powerCeil} W)
                </span>
                <span>
                  <span className="swatch refl" />
                  reverse (0–{REFLECT_PLOT_CEIL}%)
                </span>
              </div>
            </section>
          </div>

          <div className="col">
            <section className="panel">
              <h2>Matching network</h2>
              <div className="lock-badge">
                🔒 Manual tuning — locked on. The built-in auto-tuner (ATUNE) is never engaged.
              </div>
              <div className="hint" style={{ marginTop: "6px" }}>
                Tune / load cap positions (0.1% steps). Type a value, or use −/+ (hold to repeat) for
                fine adjustment.
              </div>
              <div className="cap-row" style={{ marginTop: "10px" }}>
                <span className="cap-name">Tune cap</span>
                <button
                  className="btn step-btn"
                  disabled={!connected}
                  onMouseDown={() => holdStep(() => bumpTune(-0.1))}
                  onMouseUp={stopRepeat}
                  onMouseLeave={stopRepeat}
                >
                  −
                </button>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={tune}
                  disabled={!connected}
                  onChange={(e) => sendTune(clampCap(Number(e.target.value)))}
                />
                <button
                  className="btn step-btn"
                  disabled={!connected}
                  onMouseDown={() => holdStep(() => bumpTune(0.1))}
                  onMouseUp={stopRepeat}
                  onMouseLeave={stopRepeat}
                >
                  +
                </button>
                <span className="cap-live-v">% · {capVolts(tune, TUNE_VOLTS).toFixed(2)} V</span>
                <span className="cap-readback">
                  act {t?.tune_cap_percent != null ? `${t.tune_cap_percent.toFixed(1)}%` : "—"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={tune}
                disabled={!connected}
                onChange={(e) => sendTune(Number(e.target.value))}
              />
              <div className="cap-row" style={{ marginTop: "10px" }}>
                <span className="cap-name">Load cap</span>
                <button
                  className="btn step-btn"
                  disabled={!connected}
                  onMouseDown={() => holdStep(() => bumpLoad(-0.1))}
                  onMouseUp={stopRepeat}
                  onMouseLeave={stopRepeat}
                >
                  −
                </button>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={load}
                  disabled={!connected}
                  onChange={(e) => sendLoad(clampCap(Number(e.target.value)))}
                />
                <button
                  className="btn step-btn"
                  disabled={!connected}
                  onMouseDown={() => holdStep(() => bumpLoad(0.1))}
                  onMouseUp={stopRepeat}
                  onMouseLeave={stopRepeat}
                >
                  +
                </button>
                <span className="cap-live-v">% · {capVolts(load, LOAD_VOLTS).toFixed(2)} V</span>
                <span className="cap-readback">
                  act {t?.load_cap_percent != null ? `${t.load_cap_percent.toFixed(1)}%` : "—"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={load}
                disabled={!connected}
                onChange={(e) => sendLoad(Number(e.target.value))}
              />

              {/* MODE: in manual tuning, choose which cap the shared fine −/+ act on (the AG Plasma
                  front-panel MODE button toggles LC/TC in MTUNE for faster tuning). */}
              <div className="mode-row">
                <span className="cap-name">MODE</span>
                <div className="seg">
                  <button
                    className={activeCap === "tune" ? "seg-btn on" : "seg-btn"}
                    disabled={!connected}
                    onClick={() => setActiveCap("tune")}
                  >
                    TUNE
                  </button>
                  <button
                    className={activeCap === "load" ? "seg-btn on" : "seg-btn"}
                    disabled={!connected}
                    onClick={() => setActiveCap("load")}
                  >
                    LOAD
                  </button>
                </div>
                <button
                  className="btn step-btn"
                  disabled={!connected}
                  onMouseDown={() => holdStep(() => bumpActive(-0.1))}
                  onMouseUp={stopRepeat}
                  onMouseLeave={stopRepeat}
                >
                  −
                </button>
                <button
                  className="btn step-btn"
                  disabled={!connected}
                  onMouseDown={() => holdStep(() => bumpActive(0.1))}
                  onMouseUp={stopRepeat}
                  onMouseLeave={stopRepeat}
                >
                  +
                </button>
                <span className="hint" style={{ margin: 0 }}>
                  fine-steps the active cap
                </span>
              </div>

              {/* Software presets: recall stored caps in MANUAL mode (not the forbidden ATUNE).
                  Only configured slots are shown; the save control below creates/overwrites one. */}
              <div className="field-label" style={{ marginTop: "12px", fontWeight: 700 }}>
                Presets
              </div>
              {presetEntries.length > 0 ? (
                <div className="preset-bank">
                  {presetEntries.map(([n, slot]) => (
                    <div key={n} className="preset-chip">
                      <button
                        className="preset-recall"
                        disabled={!connected}
                        title="Recall these cap positions (manual mode)"
                        onClick={() => recallPreset(n)}
                      >
                        <span className="preset-n">{n}</span>
                        <span className="preset-vals">
                          T {slot.tune_cap_percent.toFixed(1)} · L {slot.load_cap_percent.toFixed(1)}
                        </span>
                      </button>
                      <button
                        className="preset-clear"
                        disabled={!connected}
                        title="Clear this preset"
                        onClick={() => clearPreset(n)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="hint" style={{ marginTop: "4px" }}>
                  No presets saved yet — save the current cap positions below.
                </div>
              )}
              <div className="preset-save">
                <span className="hint" style={{ margin: 0 }}>
                  Save current caps →
                </span>
                <select
                  value={saveSlot}
                  disabled={!connected}
                  onChange={(e) => setSaveSlot(e.target.value)}
                >
                  {Array.from({ length: presets?.num_slots ?? 9 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      slot {n}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!connected} onClick={() => savePreset(Number(saveSlot))}>
                  Save
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>Match tuner</h2>
              <div className="banner experimental">
                <strong>Experimental — untested on hardware.</strong> Perturb-and-observe on reverse
                power: it trims the tune/load caps toward the local minimum as the load drifts. It
                never enables RF and only drives caps in <em>auto</em> while armed and RF is on.
              </div>
              <div className="ramp-actions">
                <label className="ramp-field" style={{ flex: "0 0 150px" }}>
                  <span>Mode</span>
                  <select
                    value={mt?.mode ?? "advisory"}
                    disabled={!connected}
                    onChange={(e) => setMatchMode(e.target.value)}
                  >
                    <option value="advisory">advisory (watch only)</option>
                    <option value="auto">auto (drives caps)</option>
                  </select>
                </label>
                {mt?.running ? (
                  <button className="btn" onClick={stopMatchTuner}>
                    Stop
                  </button>
                ) : (
                  <button className="btn accent" onClick={startMatchTuner} disabled={!connected}>
                    Start
                  </button>
                )}
                {mt?.armed ? (
                  <button className="btn" onClick={disarmMatchTuner}>
                    Disarm
                  </button>
                ) : (
                  <button
                    className="btn danger"
                    onClick={armMatchTuner}
                    disabled={!connected || !t?.rf_on || !mt?.running}
                    title={
                      !mt?.running
                        ? "Start the tuner first"
                        : !t?.rf_on
                          ? "Enable RF first — the tuner only drives caps while RF is on"
                          : "Arm: allow the tuner to drive the caps (auto mode)"
                    }
                  >
                    Arm
                  </button>
                )}
              </div>
              <div className="mt-readout mono">
                {mt?.running ? (
                  <>
                    <span className={`mt-phase ${mt.phase}`}>{mt.phase}</span> · reverse{" "}
                    {revPct(mt.reverse_fraction)} · best {revPct(mt.best)}
                    {mt.last_move
                      ? ` · last ${mt.last_move.axis} ${fmtDelta(mt.last_move.delta)}`
                      : ""}
                  </>
                ) : (
                  <span className="hint" style={{ margin: 0 }}>
                    Stopped. Start, then Arm in auto to trim caps toward minimum reverse (RF on).
                  </span>
                )}
              </div>
              {mt?.mode === "advisory" && mt?.recommended ? (
                <div className="hint">
                  Recommended (advisory — not applied): tune {mt.recommended.tune.toFixed(1)}% · load{" "}
                  {mt.recommended.load.toFixed(1)}%
                </div>
              ) : null}
              {mt?.running && !t?.rf_on ? (
                <div className="hint">Arming is disabled until RF is on.</div>
              ) : null}
            </section>

            <section className="panel">
              <h2>Auto-shutoff timer</h2>
              <div className="ramp-actions">
                <label className="ramp-field" style={{ flex: "0 0 82px" }}>
                  <span>Minutes</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={timerMin}
                    disabled={timer?.running}
                    onChange={(e) => setTimerMin(e.target.value)}
                  />
                </label>
                {timer?.running ? (
                  <button className="btn" onClick={stopTimer}>
                    Cancel
                  </button>
                ) : (
                  <button className="btn" onClick={startTimer} disabled={!connected}>
                    Start timer
                  </button>
                )}
                {timer?.running ? (
                  <span className="hint mono">
                    {Math.ceil(timer.remaining_s / 60)} min left → RF off
                  </span>
                ) : timer?.done ? (
                  <span className="hint mono">timer elapsed · RF commanded off</span>
                ) : (
                  <span className="hint">Commands RF off after N minutes (1–99). Never enables RF.</span>
                )}
              </div>
            </section>

            <section className="panel">
              <h2>Recording</h2>
              {recording?.active ? (
                <>
                  <button className="btn rec full" onClick={() => api.stopRecording()}>
                    ■ Stop recording
                  </button>
                  <div className="hint mono">recording → {recording.run}</div>
                </>
              ) : (
                <>
                  <input
                    className="mono"
                    style={textInputStyle}
                    placeholder="run name"
                    value={runName}
                    onChange={(e) => setRunName(e.target.value)}
                  />
                  <button
                    className="btn full"
                    disabled={!connected}
                    onClick={() => api.startRecording(runName.trim() || "run", "")}
                  >
                    ● Start recording
                  </button>
                </>
              )}
              {lastRun ? (
                <button
                  className="btn full"
                  style={{ marginTop: "8px" }}
                  onClick={() =>
                    api
                      .downloadRecording(lastRun)
                      .catch((e) => flash("download failed: " + (e as Error).message))
                  }
                >
                  ⬇ Download power curves ({lastRun}) CSV
                </button>
              ) : null}
              <div className="hint">
                Logs forward / reflected / load power + the thermal-loop commanded curve (phase,
                control temp, commanded W) to telemetry.csv.
              </div>
            </section>
          </div>
        </div>
      ) : view === "settings" ? (
        <div className="main">
          <div className="col">
            <section className="panel">
              <h2>Safety limits</h2>
              {limitsStatus ? (
                <>
                  <div className="hint">
                    Protection thresholds. You can always tighten; values are clamped to the hard
                    bounds shown and take effect on the next telemetry poll.
                  </div>
                  <label className="field-label">
                    Max forward power (W){boundHint(limitsStatus.bounds, "max_forward_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.max_forward_w}
                    onChange={(e) => setLimForm({ ...limForm, max_forward_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Max reflected power / trip (W){boundHint(limitsStatus.bounds, "max_reflected_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.max_reflected_w}
                    onChange={(e) => setLimForm({ ...limForm, max_reflected_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Over-temperature shutoff (°C){boundHint(limitsStatus.bounds, "temperature_c_trip")}
                  </label>
                  <input
                    type="number"
                    value={limForm.temperature_c_trip}
                    onChange={(e) => setLimForm({ ...limForm, temperature_c_trip: e.target.value })}
                  />
                  <div className="hint" style={{ marginTop: "12px" }}>
                    Gauge zones (display only — the forward power dials shade at these watts; they do
                    not change protection).
                  </div>
                  <label className="field-label" style={{ marginTop: "8px" }}>
                    Caution — yellow from (W){boundHint(limitsStatus.bounds, "forward_caution_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.forward_caution_w}
                    onChange={(e) => setLimForm({ ...limForm, forward_caution_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Danger — red from (W){boundHint(limitsStatus.bounds, "forward_danger_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.forward_danger_w}
                    onChange={(e) => setLimForm({ ...limForm, forward_danger_w: e.target.value })}
                  />
                  <button
                    className="btn accent full"
                    style={{ marginTop: "12px" }}
                    onClick={saveLimits}
                  >
                    Save limits
                  </button>
                </>
              ) : (
                <div className="muted">loading…</div>
              )}
            </section>

            <section className="panel">
              <h2>Thermal plan</h2>
              {thermalPlanStatus ? (
                <>
                  <div className="hint">
                    The closed-loop trajectory (ramp → approach → soak → cool). The loop ceiling is
                    additionally clamped to the max forward power. Values are clamped to the hard
                    bounds shown.
                  </div>
                  <label className="field-label">
                    Target temperature (°C){boundHint(thermalPlanStatus.bounds, "target_c")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.target_c}
                    onChange={(e) => setThermalForm({ ...thermalForm, target_c: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Soak time (s){boundHint(thermalPlanStatus.bounds, "soak_s")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.soak_s}
                    onChange={(e) => setThermalForm({ ...thermalForm, soak_s: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Loop ceiling (W){boundHint(thermalPlanStatus.bounds, "loop_ceiling_w")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.loop_ceiling_w}
                    onChange={(e) =>
                      setThermalForm({ ...thermalForm, loop_ceiling_w: e.target.value })
                    }
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Approach band (°C){boundHint(thermalPlanStatus.bounds, "approach_band_c")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.approach_band_c}
                    onChange={(e) =>
                      setThermalForm({ ...thermalForm, approach_band_c: e.target.value })
                    }
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Max step (W per tick){boundHint(thermalPlanStatus.bounds, "max_step_w")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.max_step_w}
                    onChange={(e) => setThermalForm({ ...thermalForm, max_step_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Done-below temperature (°C){boundHint(thermalPlanStatus.bounds, "done_below_c")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.done_below_c}
                    onChange={(e) => setThermalForm({ ...thermalForm, done_below_c: e.target.value })}
                  />
                  <button
                    className="btn accent full"
                    style={{ marginTop: "12px" }}
                    onClick={saveThermalPlan}
                  >
                    Save thermal plan
                  </button>
                </>
              ) : (
                <div className="muted">loading…</div>
              )}
            </section>

            <section className="panel">
              <h2>Logging</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoLog}
                  onChange={(e) => {
                    setAutoLog(e.target.checked);
                    api.setAutoLog(e.target.checked);
                  }}
                />
                Auto-log power curves on RF-on
              </label>
              <div className="hint">
                Starts a telemetry recording automatically when RF turns on (device power + the
                thermal-loop commanded curve). Keeps recording through cooldown — stop it manually.
                Download the CSV from the Recording panel.
              </div>
            </section>

            <section className="panel">
              <h2>FLIR link</h2>
              <label className="field-label" htmlFor="flir-url">
                FLIR operator URL
              </label>
              <input
                id="flir-url"
                className="mono"
                style={textInputStyle}
                placeholder="http://localhost:8000"
                value={flirUrlInput}
                onChange={(e) => setFlirUrlInput(e.target.value)}
                onBlur={applyFlirUrl}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyFlirUrl();
                }}
              />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={flirEnabled}
                  onChange={(e) => toggleFlirEnabled(e.target.checked)}
                />
                Enable FLIR link
              </label>
              <div className="hint mono">{flirStatusLabel(flirLast)}</div>
              <div className="hint">
                RF on/off starts + annotates a FLIR recording (FLIR owns stop-vs-keep).
              </div>
            </section>

            {SITE_MODE ? (
              <section className="panel">
                <h2>Operator</h2>
                <label className="field-label" htmlFor="op">
                  Local operator (tcp-serve) this UI connects to
                </label>
                <input
                  id="op"
                  className="mono"
                  style={textInputStyle}
                  value={baseInput}
                  onChange={(e) => setBaseInput(e.target.value)}
                  onBlur={applyBase}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyBase();
                  }}
                  placeholder="http://localhost:8010"
                />
              </section>
            ) : null}
          </div>
        </div>
            ) : (
              <div className="main">
                <div className="col">
                  <section className="panel">
                    <h2>Thermal control (closed loop)</h2>
                    <div className="banner warn" style={{ margin: "0 0 12px" }}>
                      <strong>Experimental — untested.</strong> Not validated on hardware. It only
                      adjusts the RF setpoint (it never enables RF) and disarms on any fault — one of
                      the later things to test.
                    </div>
                    <div className="cards">
                      <div className="readout">
                        <div className="label">Phase</div>
                        <div className={`value ${thermal?.running ? "rf-on" : ""}`}>
                          {thermal?.running ? thermal.phase : "idle"}
                        </div>
                      </div>
                      <div className="readout">
                        <div className="label">Control temp → target</div>
                        <div className="value">
                          {thermal
                            ? `${fmtTemp(thermal.control_temp_c)} → ${fmtTemp(thermal.target_c)}`
                            : "—"}
                        </div>
                      </div>
                      <div className="readout">
                        <div className="label">Recommended → applied</div>
                        <div className="value">
                          {thermal
                            ? `${fmtWatts(thermal.recommended_w)} → ${
                                thermal.applied_w === null ? "advisory" : fmtWatts(thermal.applied_w)
                              }`
                            : "—"}
                        </div>
                      </div>
                    </div>
                    <div className="gauge" style={{ marginTop: "10px" }}>
                      <div
                        className="fill ok"
                        style={{
                          width: `${
                            thermal && thermal.target_c > 0
                              ? Math.min(
                                  100,
                                  Math.max(0, (thermal.control_temp_c / thermal.target_c) * 100),
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    <label className="field-label" style={{ marginTop: "12px" }}>
                      Temperature source
                    </label>
                    <div className="row">
                      <select
                        value={thermal?.source ?? "simulated"}
                        onChange={(e) => applyThermalSource(e.target.value as "simulated" | "flir")}
                        disabled={!connected}
                      >
                        <option value="simulated">simulated model</option>
                        <option value="flir">FLIR stream</option>
                      </select>
                    </div>
                    {(thermal?.source ?? "simulated") === "flir" ? (
                      <input
                        className="mono"
                        style={textInputStyle}
                        placeholder="ws://localhost:8000/ws/frames"
                        value={thermalFlirUrl}
                        onChange={(e) => setThermalFlirUrl(e.target.value)}
                        onBlur={() => applyThermalSource("flir")}
                      />
                    ) : null}
                    <div className="row" style={{ marginTop: "10px" }}>
                      <select
                        value={thermalMode}
                        onChange={(e) => setThermalMode(e.target.value as "advisory" | "auto")}
                        disabled={thermal?.running}
                      >
                        <option value="advisory">advisory (recommend only)</option>
                        <option value="auto">auto (drive setpoint)</option>
                      </select>
                      {thermal?.running ? (
                        <button className="btn full" onClick={stopThermal}>
                          Stop loop
                        </button>
                      ) : (
                        <button
                          className="btn accent full"
                          onClick={startThermal}
                          disabled={!connected}
                        >
                          Start loop
                        </button>
                      )}
                    </div>
                    <div className="row" style={{ marginTop: "8px" }}>
                      <button
                        className="btn full"
                        onClick={armThermal}
                        disabled={!connected || !t?.rf_on || thermal?.armed}
                      >
                        {thermal?.armed ? "Armed" : "Arm"}
                      </button>
                      <button
                        className="btn full"
                        onClick={disarmThermal}
                        disabled={!connected || !thermal?.armed}
                      >
                        Disarm
                      </button>
                    </div>
                    <div className="hint">
                      Auto mode drives the RF <em>setpoint</em> within the plan ceiling. On real
                      hardware it drives only while armed and RF is on; a fault or RF-off disarms.
                      Set the trajectory in Settings → Thermal plan.
                    </div>
                  </section>

                  <section className="panel">
                    <h2>Pulse mode</h2>
                    <div className="banner warn" style={{ margin: "0 0 12px" }}>
                      <strong>Experimental — simulator only.</strong> Models the generator's PULSE
                      waveform by gating the setpoint on/off; it never enables RF. The real unit's
                      PULSE serial command is unverified, so this is not wired to hardware yet.
                    </div>
                    <div className="ramp-grid">
                      <label className="ramp-field">
                        <span>Time on (ms)</span>
                        <input
                          type="number"
                          min={1}
                          max={9995}
                          value={pulseForm.on_ms}
                          disabled={pulse?.running}
                          onChange={(e) => setPulseForm({ ...pulseForm, on_ms: e.target.value })}
                        />
                      </label>
                      <label className="ramp-field">
                        <span>Time off (ms)</span>
                        <input
                          type="number"
                          min={1}
                          max={9995}
                          value={pulseForm.off_ms}
                          disabled={pulse?.running}
                          onChange={(e) => setPulseForm({ ...pulseForm, off_ms: e.target.value })}
                        />
                      </label>
                      <label className="ramp-field">
                        <span>Power (W)</span>
                        <input
                          type="number"
                          min={0}
                          value={pulseForm.power_w}
                          disabled={pulse?.running}
                          onChange={(e) => setPulseForm({ ...pulseForm, power_w: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="ramp-actions">
                      {pulse?.running ? (
                        <button className="btn" onClick={stopPulse}>
                          Stop pulse
                        </button>
                      ) : (
                        <button className="btn accent" onClick={startPulse} disabled={!connected}>
                          Start pulse
                        </button>
                      )}
                      <span className="hint mono" style={{ margin: 0 }}>
                        duty {pulse ? Math.round(pulse.duty * 100) : "—"}%
                        {pulse?.running ? ` · ${pulse.output_on ? "ON" : "off"}` : ""}
                      </span>
                    </div>
                  </section>
                </div>
              </div>
            )}
          </>
        )}
      </ErrorBoundary>

      {toast ? <div className="toast">{toast}</div> : null}

      {showStartup ? (
        <div className="modal-overlay" onClick={() => setShowStartup(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Power-on order</h2>
              <button
                className="modal-close"
                onClick={() => setShowStartup(false)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
            <p className="modal-lead">
              <strong>Turn the generator ON before the AIT (matching network).</strong> Powering the
              AIT first shifts the caps and ruins the tune.
            </p>
            <ol className="modal-steps">
              <li>Load the part into the electrodes inside the chamber.</li>
              <li>Connect the VNA and assess the match (S11).</li>
              <li>Turn on the AIT; adjust tune / load to reach a match.</li>
              <li>Turn off the AIT; unplug the VNA.</li>
              <li>Plug the N-type cable into the RF generator.</li>
              <li>Confirm everything is in place and safe.</li>
              <li>
                <strong>Turn on the generator → wait for boot → turn on the AIT.</strong>
              </li>
            </ol>
            <button className="btn accent full" onClick={() => setShowStartup(false)}>
              Got it
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
