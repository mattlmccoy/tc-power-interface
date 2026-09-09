import type { Operator } from "../hooks/useOperator.ts";
import { GeneratorPanel } from "../components/GeneratorPanel.tsx";
import { HistoryPanel } from "../components/HistoryPanel.tsx";
import { MatchingNetworkPanel } from "../components/MatchingNetworkPanel.tsx";
import { MatchTunerPanel } from "../components/MatchTunerPanel.tsx";
import VnaPanel from "../components/VnaPanel.tsx";
import { RecordingPanel } from "../components/RecordingPanel.tsx";
import { RfPowerPanel } from "../components/RfPowerPanel.tsx";
import { TelemetryPanel } from "../components/TelemetryPanel.tsx";
import { TimerPanel } from "../components/TimerPanel.tsx";

export function DashboardPage({ op }: { op: Operator }) {
  const { activeCap, applyLoadVolts, applySetpoint, applyTuneVolts, armDevice, armMatchTuner, armed, bumpActive, bumpLoad, bumpTune, capBusy, clearPreset, connected, controllable, device, disarmDevice, disarmMatchTuner, estop, faulted, flash, fmtDelta, fwdCaution, fwdDanger, lastRun, limits, load, loadVIn, maxRefl, mt, nudgeSetpoint, onSetpointKey, plot, powerCeil, presetEntries, presets, ramp, rampForm, recallPreset, recording, reflFillPct, requested, revPct, rfOff, rfOn, runName, savePreset, saveSlot, sendLoad, sendTune, setActiveCap, setLoadVIn, setMatchMode, setRampForm, setRunName, setSaveSlot, setSetpointInput, setTimerMin, setTuneVIn, setpointInput, setpointRef, showGauges, startMatchTuner, startRamp, startTimer, stopMatchTuner, stopRamp, stopTimer, t, textInputStyle, timer, timerMin, toggleGauges, tune, tuneVIn, zone } = op;
  return (
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

            <VnaPanel
              status={op.status}
              controllable={controllable}
              sendTune={sendTune}
              sendLoad={sendLoad}
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
  );
}
