import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
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
import { RfPowerPanel } from "./components/RfPowerPanel.tsx";
import { TelemetryPanel } from "./components/TelemetryPanel.tsx";
import { SITE_MODE } from "./lib/api.ts";
import { UI_API_VERSION, UI_VERSION } from "./lib/operator.ts";
import { useOperator } from "./hooks/useOperator.ts";

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
            <TelemetryPanel
              showGauges={showGauges}
              toggleGauges={toggleGauges}
              ramp={ramp}
              requested={requested}
              t={t}
              powerCeil={powerCeil}
              maxRefl={maxRefl}
              fwdCaution={fwdCaution}
              fwdDanger={fwdDanger}
              zone={zone}
            />

            <RfPowerPanel
              connected={connected}
              armed={armed}
              controllable={controllable}
              faulted={faulted}
              estop={estop}
              armDevice={armDevice}
              disarmDevice={disarmDevice}
              rfOn={rfOn}
              rfOff={rfOff}
              setpointInput={setpointInput}
              setSetpointInput={setSetpointInput}
              setpointRef={setpointRef}
              applySetpoint={applySetpoint}
              nudgeSetpoint={nudgeSetpoint}
              onSetpointKey={onSetpointKey}
              limits={limits}
              ramp={ramp}
              rampForm={rampForm}
              setRampForm={setRampForm}
              startRamp={startRamp}
              stopRamp={stopRamp}
              t={t}
              zone={zone}
              reflFillPct={reflFillPct}
              maxRefl={maxRefl}
            />

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
