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
import { LoggingPanel } from "./components/LoggingPanel.tsx";
import { ThermalPlanPanel } from "./components/ThermalPlanPanel.tsx";
import { SafetyLimitsPanel } from "./components/SafetyLimitsPanel.tsx";
import { RecordingPanel } from "./components/RecordingPanel.tsx";
import { TimerPanel } from "./components/TimerPanel.tsx";
import { MatchTunerPanel } from "./components/MatchTunerPanel.tsx";
import { MatchingNetworkPanel } from "./components/MatchingNetworkPanel.tsx";
import { GeneratorPanel } from "./components/GeneratorPanel.tsx";
import { SITE_MODE } from "./lib/api.ts";
import { fmtWatts } from "./lib/format.ts";
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

            <GeneratorPanel t={t} limits={limits} device={device} />

            <HistoryPanel plot={plot} powerCeil={powerCeil} />
          </div>

          <div className="col">
            <MatchingNetworkPanel
              controllable={controllable}
              capBusy={capBusy}
              tune={tune}
              load={load}
              t={t}
              tuneVIn={tuneVIn}
              setTuneVIn={setTuneVIn}
              loadVIn={loadVIn}
              setLoadVIn={setLoadVIn}
              applyTuneVolts={applyTuneVolts}
              applyLoadVolts={applyLoadVolts}
              sendTune={sendTune}
              sendLoad={sendLoad}
              bumpTune={bumpTune}
              bumpLoad={bumpLoad}
              activeCap={activeCap}
              setActiveCap={setActiveCap}
              bumpActive={bumpActive}
              presets={presets}
              presetEntries={presetEntries}
              saveSlot={saveSlot}
              setSaveSlot={setSaveSlot}
              savePreset={savePreset}
              clearPreset={clearPreset}
              recallPreset={recallPreset}
            />

            <MatchTunerPanel
              controllable={controllable}
              t={t}
              mt={mt}
              setMatchMode={setMatchMode}
              startMatchTuner={startMatchTuner}
              stopMatchTuner={stopMatchTuner}
              armMatchTuner={armMatchTuner}
              disarmMatchTuner={disarmMatchTuner}
              revPct={revPct}
              fmtDelta={fmtDelta}
            />

            <TimerPanel
              controllable={controllable}
              timer={timer}
              timerMin={timerMin}
              setTimerMin={setTimerMin}
              startTimer={startTimer}
              stopTimer={stopTimer}
            />

            <RecordingPanel
              controllable={controllable}
              recording={recording}
              lastRun={lastRun}
              runName={runName}
              setRunName={setRunName}
              flash={flash}
              textInputStyle={textInputStyle}
            />
          </div>
        </div>
      ) : view === "settings" ? (
        <div className="main">
          <div className="col">
            <SafetyLimitsPanel
              limitsStatus={limitsStatus}
              limForm={limForm}
              setLimForm={setLimForm}
              saveLimits={saveLimits}
            />

            <ThermalPlanPanel
              thermalPlanStatus={thermalPlanStatus}
              thermalForm={thermalForm}
              setThermalForm={setThermalForm}
              saveThermalPlan={saveThermalPlan}
            />

            <LoggingPanel autoLog={autoLog} setAutoLog={setAutoLog} />

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
