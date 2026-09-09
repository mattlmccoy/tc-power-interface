import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Gauge } from "./components/Gauge.tsx";
import { StatusLeds } from "./components/StatusLeds.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { StartupModal } from "./components/StartupModal.tsx";
import { Toast } from "./components/Toast.tsx";
import { PulsePanel } from "./components/PulsePanel.tsx";
import { ThermalControlPanel } from "./components/ThermalControlPanel.tsx";
import { OperatorPanel } from "./components/OperatorPanel.tsx";
import { FlirLinkPanel } from "./components/FlirLinkPanel.tsx";
import { api, SITE_MODE } from "./lib/api.ts";
import { boundHint, fmtTemp, fmtWatts } from "./lib/format.ts";
import { capVolts, generatorModes, LOAD_CAL, tempBar, TUNE_CAL } from "./lib/instrument.ts";
import { UI_API_VERSION, UI_VERSION } from "./lib/operator.ts";
import { useOperator } from "./hooks/useOperator.ts";

const SP_FINE = 5; // live power nudge: fine step (W) — ↑/↓ and the ±5 buttons
const SP_COARSE = 25; // live power nudge: coarse step (W) — Shift+↑/↓ and the ±25 buttons

export function App() {
  const op = useOperator();
  const {
    device, view, setView, showHelp, toggleHelp, pillState, showConnect, setShowConnect, ports,
    scanPorts, baseInput, setBaseInput, applyBase, setPorts, setConnectErr, connected,
    disconnectDevice, connectBusy, connectErr, connectPort, health, reachable, handshake, faulted,
    ctrl, ramp, showGauges, toggleGauges, requested, powerCeil, fwdCaution, fwdDanger, t, maxRefl,
    zone, estop, armed, disarmDevice, armDevice, controllable, rfOn, rfOff, setpointInput,
    setSetpointInput, setpointRef, applySetpoint, nudgeSetpoint, limits, rampForm, setRampForm,
    startRamp, stopRamp, onSetpointKey, reflFillPct, plot, tune, tuneVIn, setTuneVIn, capBusy,
    applyTuneVolts, bumpTune, load, loadVIn, setLoadVIn, applyLoadVolts, bumpLoad, sendTune,
    sendLoad, activeCap, setActiveCap, bumpActive, presetEntries, recallPreset, clearPreset,
    presets, saveSlot, setSaveSlot, savePreset, mt, setMatchMode, stopMatchTuner, startMatchTuner,
    disarmMatchTuner, armMatchTuner, revPct, fmtDelta, timer, timerMin, setTimerMin, stopTimer,
    startTimer, recording, runName, setRunName, lastRun, flash, textInputStyle, limitsStatus,
    limForm, setLimForm, saveLimits, thermalPlanStatus, thermalForm, setThermalForm,
    saveThermalPlan, autoLog, setAutoLog, flirUrlInput, setFlirUrlInput, applyFlirUrl, flirEnabled,
    toggleFlirEnabled, flirLast, thermal, thermalMode, setThermalMode, applyThermalSource,
    thermalFlirUrl, setThermalFlirUrl, applyControlRoi, startThermal, stopThermal, armThermal,
    disarmThermal, pulse, pulseForm, setPulseForm, startPulse, stopPulse, toast, showStartup,
    setShowStartup,
  } = op;
  return (
    <div className={`app ${showHelp ? "" : "help-off"}`}>
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
        <button
          className={`help-toggle ${showHelp ? "on" : ""}`}
          onClick={toggleHelp}
          title={showHelp ? "Hide explanatory text" : "Show explanatory text"}
        >
          ? Help
        </button>
        <div className="connect-wrap">
          <button
            className={`pill ${pillState}`}
            onClick={() => {
              setShowConnect((v) => !v);
              if (ports === null) void scanPorts();
            }}
            title="Connect a generator / set the operator address"
          >
            <span className="dot" />
            {pillState}
            <span className="pill-caret">▾</span>
          </button>
          {showConnect ? (
            <div className="connect-pop">
              <div className="connect-head">
                <strong>Connection</strong>
                <button className="pop-close" onClick={() => setShowConnect(false)}>
                  ✕
                </button>
              </div>

              {SITE_MODE ? (
                <div className="connect-sec">
                  <label className="field-label">Operator address</label>
                  <div className="connect-row">
                    <input
                      value={baseInput}
                      onChange={(e) => setBaseInput(e.target.value)}
                      placeholder="http://localhost:8010"
                      spellCheck={false}
                    />
                    <button
                      className="btn"
                      onClick={() => {
                        applyBase();
                        setPorts(null);
                        setConnectErr(null);
                      }}
                    >
                      Apply
                    </button>
                  </div>
                  <div className="hint help-text">
                    The local operator that serves your generator. Default{" "}
                    <code>http://localhost:8010</code>.
                  </div>
                </div>
              ) : null}

              <div className="connect-sec">
                <div className="connect-row connect-row-head">
                  <label className="field-label">Device</label>
                  <button className="btn" onClick={scanPorts} disabled={connectBusy === "scanning"}>
                    {connectBusy === "scanning" ? "Scanning…" : "Scan"}
                  </button>
                </div>

                {connected ? (
                  <div className="connect-current">
                    <span>
                      Connected{device?.id ? ` — ${device.id}` : ""}
                    </span>
                    <button
                      className="btn danger"
                      onClick={disconnectDevice}
                      disabled={connectBusy === "disconnect"}
                    >
                      {connectBusy === "disconnect" ? "…" : "Disconnect"}
                    </button>
                  </div>
                ) : ports === null ? (
                  <div className="hint">Scan to find the generator's serial port.</div>
                ) : ports.length === 0 ? (
                  <div className="errbox">
                    No serial ports found. Plug in the generator's USB-serial cable and Scan again.
                  </div>
                ) : (
                  <ul className="port-list">
                    {ports.map((p) => (
                      <li key={p.device}>
                        <div className="port-info">
                          <div className="port-name">{p.description || p.device}</div>
                          <code>{p.device}</code>
                        </div>
                        <button
                          className="btn accent"
                          onClick={() => connectPort(p.device)}
                          disabled={connectBusy !== null}
                        >
                          {connectBusy === p.device ? "Connecting…" : "Connect"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {connectErr ? <div className="errbox">{connectErr}</div> : null}
                <div className="hint help-text">
                  Connecting is read-only — RF stays off. Verify readings against the front panel
                  before enabling RF (this unit's protocol is unconfirmed).
                </div>
              </div>

              <div className="connect-version mono">
                UI {UI_VERSION}
                {health ? ` · operator ${health.version}` : reachable ? "" : " · operator offline"}
                {" · API "}
                {UI_API_VERSION}
                {health?.api_version ? `/${health.api_version}` : ""}
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {handshake && handshake.level !== "ok" ? (
        <div className={`banner ${handshake.level === "refuse" ? "fault" : "warn"}`}>
          <strong>Version mismatch.</strong> {handshake.message}
        </div>
      ) : null}
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
                    label="Load"
                    value={t ? t.load_w : null}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                  <Gauge
                    label="Reverse"
                    value={t ? t.reverse_w : null}
                    max={maxRefl}
                    caution={maxRefl * 0.5}
                    danger={maxRefl * 0.8}
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
                  <div className="readout">
                    <div className="label">Load power</div>
                    <div className="value">{t ? fmtWatts(t.load_w) : "—"}</div>
                  </div>
                  <div className={`readout zone-${zone}`}>
                    <div className="label">Reverse power</div>
                    <div className="value">{t ? fmtWatts(t.reverse_w) : "—"}</div>
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
                  {/* ARM gate: a connected device is read-only until armed (replaces the CLI probe). */}
                  {connected ? (
                    armed ? (
                      <button
                        className="btn full disarm-btn"
                        onClick={disarmDevice}
                        style={{ marginTop: "8px" }}
                        title="Drop control: RF off, back to read-only"
                      >
                        ● ARMED — click to DISARM
                      </button>
                    ) : (
                      <button
                        className="btn full arm-btn"
                        onClick={armDevice}
                        style={{ marginTop: "8px" }}
                        title="Take control of the device (unlocks RF, setpoint, caps)"
                      >
                        ▲ ARM — take control
                      </button>
                    )
                  ) : null}
                  <div className="row" style={{ marginTop: "8px" }}>
                    <button
                      className="btn danger full"
                      onClick={rfOn}
                      disabled={!controllable || faulted}
                    >
                      RF ON
                    </button>
                    <button className="btn full" onClick={rfOff} disabled={!connected}>
                      RF OFF
                    </button>
                  </div>
                  <div className="hint">
                    {!connected
                      ? "Connect a generator to begin."
                      : !armed
                        ? "Read-only. Check the readings against the front panel, then ARM to take control."
                        : faulted
                          ? "RF-enable blocked while faulted."
                          : "Armed. RF-enable prompts to confirm; protection commands RF off on any trip."}
                  </div>
                </div>
                <div className="setpoint-box">
                  <label className="field-label" htmlFor="sp">
                    Forward power setpoint (W)
                  </label>
                  <div className="setpoint-entry">
                    <input
                      id="sp"
                      className="setpoint-input"
                      type="number"
                      min={0}
                      value={setpointInput}
                      onChange={(e) => {
                        setSetpointInput(e.target.value);
                        const n = Number(e.target.value);
                        if (e.target.value.trim() !== "" && !Number.isNaN(n)) setpointRef.current = n;
                      }}
                      onKeyDown={onSetpointKey}
                    />
                    <span className="setpoint-unit">W</span>
                    <button className="btn accent" onClick={applySetpoint} disabled={!controllable}>
                      Apply
                    </button>
                  </div>
                  {/* Live power nudge — each press sends instantly (no Apply), clamped to the ceiling.
                      Single-click only (no auto-repeat), like the cap steppers. ↑/↓ = ±fine on the
                      field, Shift+↑/↓ = ±coarse. */}
                  <div className="setpoint-nudge">
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(-SP_COARSE)} disabled={!controllable}>
                      −{SP_COARSE}
                    </button>
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(-SP_FINE)} disabled={!controllable}>
                      −{SP_FINE}
                    </button>
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(SP_FINE)} disabled={!controllable}>
                      +{SP_FINE}
                    </button>
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(SP_COARSE)} disabled={!controllable}>
                      +{SP_COARSE}
                    </button>
                  </div>
                  <div className="hint">
                    Live −/+ sends at once (no Apply) · ↑/↓ ±{SP_FINE}, Shift ±{SP_COARSE} W · ceiling{" "}
                    {limits?.max_forward_w ?? "—"} W (clamped). Edit in Settings.
                  </div>
                  <div className="setpoint-ramp">
                    <label className="switch" title="Ramp 0 → setpoint at the set rate">
                      <input
                        type="checkbox"
                        checked={!!ramp?.running}
                        // Start needs control (armed); OFF is always allowed while it's running, so
                        // a ramp can never get 'stuck on'.
                        disabled={!controllable && !ramp?.running}
                        onChange={(e) => (e.target.checked ? startRamp() : stopRamp())}
                      />
                      <span className="switch-slider" />
                    </label>
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
                  </div>
                  {/* Always rendered (space reserved) so toggling the ramp never shifts the row
                      above it — the line is blank when idle. */}
                  <div className="ramp-status hint mono" aria-hidden={!ramp?.running}>
                    {ramp?.running
                      ? `▲ ramping ${ramp.output_w} → ${ramp.target_w} W${ramp.done ? " · reached" : ""}`
                      : " "}
                  </div>
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

            <HistoryPanel plot={plot} powerCeil={powerCeil} />
          </div>

          <div className="col">
            <section className="panel">
              <h2>Matching network</h2>
              <div className="lock-badge">
                🔒 Manual tuning — locked on.
                <span className="help-text"> The built-in auto-tuner (ATUNE) is never engaged.</span>
              </div>
              <div className="hint" style={{ marginTop: "6px" }}>
                Set a cap to a target VNA voltage (snaps to the nearest whole percent — the
                generator's 1% resolution). Set always lands from below to cancel the AIT's
                backlash, so it takes a few seconds. Or nudge % with −/+.
              </div>

              {/* Tune cap: voltage-primary, whole-percent steppers */}
              <div className="cap-row cap-head" style={{ marginTop: "10px" }}>
                <span className="cap-name">Tune cap</span>
                <span className="cap-now">
                  {tune}% · {capVolts(tune, TUNE_CAL).toFixed(2)} V
                </span>
                <span className="cap-readback">
                  act{" "}
                  {t?.tune_cap_percent != null
                    ? `${t.tune_cap_percent.toFixed(1)}% · ${capVolts(t.tune_cap_percent, TUNE_CAL).toFixed(2)} V`
                    : "—"}
                </span>
              </div>
              <div className="cap-ctl">
                <input
                  type="number"
                  className="cap-v-input"
                  step={0.01}
                  placeholder="target"
                  value={tuneVIn}
                  disabled={!controllable || capBusy === "tune"}
                  onChange={(e) => setTuneVIn(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyTuneVolts()}
                />
                <span className="cap-vunit">V</span>
                <button className="btn" onClick={applyTuneVolts} disabled={!controllable || capBusy === "tune"}>
                  {capBusy === "tune" ? "Set…" : "Set"}
                </button>
                <span className="cap-ctl-gap" />
                <button className="btn step-btn" onClick={() => bumpTune(-1)} disabled={!controllable || capBusy === "tune"}>
                  −
                </button>
                <span className="cap-pct">{tune}%</span>
                <button className="btn step-btn" onClick={() => bumpTune(1)} disabled={!controllable || capBusy === "tune"}>
                  +
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={tune}
                disabled={!controllable || capBusy === "tune"}
                onChange={(e) => sendTune(Number(e.target.value))}
              />

              {/* Load cap */}
              <div className="cap-row cap-head" style={{ marginTop: "14px" }}>
                <span className="cap-name">Load cap</span>
                <span className="cap-now">
                  {load}% · {capVolts(load, LOAD_CAL).toFixed(2)} V
                </span>
                <span className="cap-readback">
                  act{" "}
                  {t?.load_cap_percent != null
                    ? `${t.load_cap_percent.toFixed(1)}% · ${capVolts(t.load_cap_percent, LOAD_CAL).toFixed(2)} V`
                    : "—"}
                </span>
              </div>
              <div className="cap-ctl">
                <input
                  type="number"
                  className="cap-v-input"
                  step={0.01}
                  placeholder="target"
                  value={loadVIn}
                  disabled={!controllable || capBusy === "load"}
                  onChange={(e) => setLoadVIn(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyLoadVolts()}
                />
                <span className="cap-vunit">V</span>
                <button className="btn" onClick={applyLoadVolts} disabled={!controllable || capBusy === "load"}>
                  {capBusy === "load" ? "Set…" : "Set"}
                </button>
                <span className="cap-ctl-gap" />
                <button className="btn step-btn" onClick={() => bumpLoad(-1)} disabled={!controllable || capBusy === "load"}>
                  −
                </button>
                <span className="cap-pct">{load}%</span>
                <button className="btn step-btn" onClick={() => bumpLoad(1)} disabled={!controllable || capBusy === "load"}>
                  +
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={load}
                disabled={!controllable || capBusy === "load"}
                onChange={(e) => sendLoad(Number(e.target.value))}
              />

              {/* MODE: in manual tuning, choose which cap the shared fine −/+ act on (the AG Plasma
                  front-panel MODE button toggles LC/TC in MTUNE for faster tuning). */}
              <div className="mode-row">
                <span className="cap-name">MODE</span>
                <div className="seg">
                  <button
                    className={activeCap === "tune" ? "seg-btn on" : "seg-btn"}
                    disabled={!controllable}
                    onClick={() => setActiveCap("tune")}
                  >
                    TUNE
                  </button>
                  <button
                    className={activeCap === "load" ? "seg-btn on" : "seg-btn"}
                    disabled={!controllable}
                    onClick={() => setActiveCap("load")}
                  >
                    LOAD
                  </button>
                </div>
                <button
                  className="btn step-btn"
                  disabled={!controllable}
                  onClick={() => bumpActive(-1)}
                >
                  −
                </button>
                <button
                  className="btn step-btn"
                  disabled={!controllable}
                  onClick={() => bumpActive(1)}
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
                        disabled={!controllable}
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
                        disabled={!controllable}
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
                  disabled={!controllable}
                  onChange={(e) => setSaveSlot(e.target.value)}
                >
                  {Array.from({ length: presets?.num_slots ?? 9 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      slot {n}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!controllable} onClick={() => savePreset(Number(saveSlot))}>
                  Save
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>Match tuner</h2>
              <div className="banner experimental help-text">
                <strong>Experimental — untested on hardware.</strong> Perturb-and-observe on reverse
                power: it trims the tune/load caps toward the local minimum as the load drifts. It
                never enables RF and only drives caps in <em>auto</em> while armed and RF is on.
              </div>
              <div className="ramp-actions">
                <label className="ramp-field" style={{ flex: "0 0 150px" }}>
                  <span>Mode</span>
                  <select
                    value={mt?.mode ?? "advisory"}
                    disabled={!controllable}
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
                  <button className="btn accent" onClick={startMatchTuner} disabled={!controllable}>
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
                    disabled={!controllable || !t?.rf_on || !mt?.running}
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
                  <button className="btn" onClick={startTimer} disabled={!controllable}>
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
                    disabled={!controllable}
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

            <FlirLinkPanel
              flirUrlInput={flirUrlInput}
              setFlirUrlInput={setFlirUrlInput}
              flirEnabled={flirEnabled}
              flirLast={flirLast}
              applyFlirUrl={applyFlirUrl}
              toggleFlirEnabled={toggleFlirEnabled}
              textInputStyle={textInputStyle}
            />

            {SITE_MODE ? (
              <OperatorPanel
                baseInput={baseInput}
                setBaseInput={setBaseInput}
                applyBase={applyBase}
                textInputStyle={textInputStyle}
              />
            ) : null}
          </div>
        </div>
            ) : (
              <div className="main">
                <div className="col">
                  <ThermalControlPanel
                    controllable={controllable}
                    connected={connected}
                    t={t}
                    thermal={thermal}
                    thermalMode={thermalMode}
                    setThermalMode={setThermalMode}
                    thermalFlirUrl={thermalFlirUrl}
                    setThermalFlirUrl={setThermalFlirUrl}
                    startThermal={startThermal}
                    stopThermal={stopThermal}
                    armThermal={armThermal}
                    disarmThermal={disarmThermal}
                    applyThermalSource={applyThermalSource}
                    applyControlRoi={applyControlRoi}
                    textInputStyle={textInputStyle}
                  />

                  <PulsePanel
                    controllable={controllable}
                    pulse={pulse}
                    pulseForm={pulseForm}
                    setPulseForm={setPulseForm}
                    startPulse={startPulse}
                    stopPulse={stopPulse}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </ErrorBoundary>

      <Toast toast={toast} />

      <StartupModal open={showStartup} onClose={() => setShowStartup(false)} />
    </div>
  );
}
