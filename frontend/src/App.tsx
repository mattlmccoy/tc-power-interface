import { useEffect, useRef, useState } from "react";

import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { TimePlot } from "./components/TimePlot.tsx";
import { api, detail, operatorBase, setOperatorBase, SITE_MODE } from "./lib/api.ts";
import type { FlirLink } from "./lib/api.ts";
import {
  boundHint,
  flirStatusLabel,
  fmtTemp,
  fmtWatts,
  reflectedZone,
  statusFlagNames,
} from "./lib/format.ts";
import { wsUrl } from "./lib/operator.ts";
import { TraceBuffer } from "./lib/telemetry.ts";
import type { Point, SafetyLimitsStatus, Status, ThermalPlanStatus } from "./lib/telemetry.ts";

const FLIR_POLL_MS = 3000;
const REFLECT_PLOT_CEIL = 15; // history-plot reflected % y-scale

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [setpointInput, setSetpointInput] = useState("100");
  const [tune, setTune] = useState(50);
  const [load, setLoad] = useState(50);
  const [manual, setManual] = useState(false);
  const [runName, setRunName] = useState("");
  const [plot, setPlot] = useState<{ fwd: Point[]; refl: Point[] }>({ fwd: [], refl: [] });
  const [base, setBase] = useState(operatorBase());
  const [baseInput, setBaseInput] = useState(operatorBase());
  const [flirUrlInput, setFlirUrlInput] = useState("");
  const [flirEnabled, setFlirEnabled] = useState(false);
  const [flirLast, setFlirLast] = useState<FlirLink["last_result"] | null>(null);
  const [limitsStatus, setLimitsStatus] = useState<SafetyLimitsStatus | null>(null);
  const [limForm, setLimForm] = useState({ max_forward_w: "", max_reflected_w: "", temperature_c_trip: "" });
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
      try {
        const lim = await api.safetyLimits();
        if (!cancelled) fillLimForm(lim);
      } catch {
        /* keep last known */
      }
      try {
        const tp = await api.thermalPlan();
        if (!cancelled) fillThermalForm(tp);
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
  const state = ctrl?.state ?? "disconnected";
  const pillState = !connected ? "disconnected" : state === "fault" ? "fault" : "connected";
  const faulted = state === "fault";
  const maxRefl = limits?.max_reflected_w ?? 25;
  const reflW = t?.reverse_w ?? 0;
  const zone = t ? reflectedZone(reflW, maxRefl * 0.5, maxRefl) : "ok";
  const reflFillPct = Math.min(100, (reflW / maxRefl) * 100);
  const powerCeil = device?.power_limit_w ?? 600;

  async function rfOn() {
    if (!window.confirm("Enable RF output now? The generator will begin delivering power.")) return;
    const res = await api.rfEnable();
    if (!res.ok) flash("RF enable refused: " + (await detail(res)));
  }
  async function rfOff() {
    await api.rfDisable();
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
  async function toggleManual(on: boolean) {
    setManual(on);
    await api.manual(on);
  }
  async function sendTune(v: number) {
    setTune(v);
    await api.tune(v);
  }
  async function sendLoad(v: number) {
    setLoad(v);
    await api.load(v);
  }
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
    };
    if (Object.values(body).some((n) => Number.isNaN(n))) return flash("limits must be numbers");
    const res = await api.saveSafetyLimits(body);
    if (res.ok) {
      fillLimForm((await res.json()) as SafetyLimitsStatus);
      flash("safety limits saved");
    } else {
      flash(await detail(res));
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
    const res = await api.saveThermalPlan(body);
    if (res.ok) {
      fillThermalForm((await res.json()) as ThermalPlanStatus);
      flash("thermal plan saved");
    } else {
      flash(await detail(res));
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
              <h2>Telemetry</h2>
              <div className="cards">
                <div className="readout">
                  <div className="label">Forward power</div>
                  <div className={`value ${t?.rf_on ? "rf-on" : ""}`}>
                    {t ? fmtWatts(t.forward_w) : "—"}
                  </div>
                </div>
                <div className={`readout zone-${zone}`}>
                  <div className="label">Reflected power</div>
                  <div className="value">{t ? fmtWatts(t.reverse_w) : "—"}</div>
                </div>
                <div className="readout">
                  <div className="label">Load power</div>
                  <div className="value">{t ? fmtWatts(t.load_w) : "—"}</div>
                </div>
                <div className="readout">
                  <div className="label">Heat-sink temp</div>
                  <div className="value">{t ? fmtTemp(t.temperature_c) : "—"}</div>
                </div>
              </div>
              <div className="hint mono">
                RF {t?.rf_on ? "ON" : "off"} · mode {t?.operation_mode ?? "—"} · tuner{" "}
                {t?.tuner ?? "—"}
                {t && statusFlagNames(t.status).length > 0
                  ? ` · ${statusFlagNames(t.status).join(", ")}`
                  : ""}
              </div>
            </section>

            <section className="panel">
              <h2>Reflected power</h2>
              <div className="gauge">
                <div className={`fill ${zone}`} style={{ width: `${reflFillPct}%` }} />
              </div>
              <div className="gauge-legend">
                <span>0 W</span>
                <span>warn {(maxRefl * 0.5).toFixed(0)} W · trip {maxRefl.toFixed(0)} W</span>
                <span>{maxRefl.toFixed(0)} W</span>
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
                  reflected (0–{REFLECT_PLOT_CEIL}%)
                </span>
              </div>
            </section>
          </div>

          <div className="col">
            <section className="panel">
              <h2>Power setpoint</h2>
              <label className="field-label" htmlFor="sp">
                Forward power (W)
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
                Ceiling {limits?.max_forward_w ?? "—"} W (values above are clamped). Edit in Settings.
              </div>
            </section>

            <section className="panel">
              <h2>RF output</h2>
              <div className="row">
                <button className="btn danger full" onClick={rfOn} disabled={!connected || faulted}>
                  RF ON
                </button>
                <button className="btn full" onClick={rfOff} disabled={!connected}>
                  RF OFF
                </button>
              </div>
              <div className="hint">
                {faulted
                  ? "RF-enable is blocked while faulted (protection latched)."
                  : "RF-enable prompts for confirmation. Protection commands RF off on any trip."}
              </div>
            </section>

            <section className="panel">
              <h2>Thermal control (closed loop)</h2>
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
                    {thermal ? `${fmtTemp(thermal.control_temp_c)} → ${fmtTemp(thermal.target_c)}` : "—"}
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
                        ? Math.min(100, Math.max(0, (thermal.control_temp_c / thermal.target_c) * 100))
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
                  <button className="btn accent full" onClick={startThermal} disabled={!connected}>
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
                Auto mode drives the RF <em>setpoint</em> within the plan ceiling — it never enables
                RF. On real hardware it drives only while armed and RF is on; a fault or RF-off
                disarms. Set the trajectory in Settings → Thermal plan.
              </div>
            </section>

            <section className="panel">
              <h2>Matching network</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(e) => toggleManual(e.target.checked)}
                  disabled={!connected}
                />
                Manual tune mode
              </label>
              <div style={{ marginTop: "12px" }}>
                <label className="field-label">Tune {tune}%</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={tune}
                  disabled={!manual}
                  onChange={(e) => sendTune(Number(e.target.value))}
                />
                <label className="field-label">Load {load}%</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={load}
                  disabled={!manual}
                  onChange={(e) => sendLoad(Number(e.target.value))}
                />
              </div>
              <div className="hint">Capacities are writable only in manual mode.</div>
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
            </section>
          </div>
        </div>
      ) : (
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
                  <button
                    className="btn accent full"
                    style={{ marginTop: "12px" }}
                    onClick={saveLimits}
                    disabled={!connected}
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
                    disabled={!connected}
                  >
                    Save thermal plan
                  </button>
                </>
              ) : (
                <div className="muted">loading…</div>
              )}
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
            )}
          </>
        )}
      </ErrorBoundary>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
