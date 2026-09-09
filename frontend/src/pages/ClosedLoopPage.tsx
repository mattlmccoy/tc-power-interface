import type { Operator } from "../hooks/useOperator.ts";
import { HistoryPanel } from "../components/HistoryPanel.tsx";
import { MatchingNetworkPanel } from "../components/MatchingNetworkPanel.tsx";
import { MatchTunerPanel } from "../components/MatchTunerPanel.tsx";
import { RfPowerPanel } from "../components/RfPowerPanel.tsx";
import { TelemetryPanel } from "../components/TelemetryPanel.tsx";
import { ThermalHero } from "../components/ThermalHero.tsx";

// The Closed-loop page: the thermal loop as the hero, with a compact band that reuses the SAME
// Dashboard panels (so nothing the operator needs mid-run is behind another tab), plus a reserved
// Calibration slot for the sibling calibration-routine session.
export function ClosedLoopPage({ op }: { op: Operator }) {
  return (
    <div className="closed-loop">
      <ThermalHero op={op} />
      <div className="main">
        <div className="col">
          <RfPowerPanel
            connected={op.connected}
            armed={op.armed}
            controllable={op.controllable}
            faulted={op.faulted}
            estop={op.estop}
            armDevice={op.armDevice}
            disarmDevice={op.disarmDevice}
            rfOn={op.rfOn}
            rfOff={op.rfOff}
            setpointInput={op.setpointInput}
            setSetpointInput={op.setSetpointInput}
            setpointRef={op.setpointRef}
            applySetpoint={op.applySetpoint}
            nudgeSetpoint={op.nudgeSetpoint}
            onSetpointKey={op.onSetpointKey}
            limits={op.limits}
            ramp={op.ramp}
            rampForm={op.rampForm}
            setRampForm={op.setRampForm}
            startRamp={op.startRamp}
            stopRamp={op.stopRamp}
            t={op.t}
            zone={op.zone}
            reflFillPct={op.reflFillPct}
            maxRefl={op.maxRefl}
          />

          <TelemetryPanel
            showGauges={op.showGauges}
            toggleGauges={op.toggleGauges}
            ramp={op.ramp}
            requested={op.requested}
            t={op.t}
            powerCeil={op.powerCeil}
            maxRefl={op.maxRefl}
            fwdCaution={op.fwdCaution}
            fwdDanger={op.fwdDanger}
            zone={op.zone}
          />

          <HistoryPanel plot={op.plot} powerCeil={op.powerCeil} />
        </div>

        <div className="col">
          <MatchingNetworkPanel
            controllable={op.controllable}
            capBusy={op.capBusy}
            tune={op.tune}
            load={op.load}
            t={op.t}
            tuneVIn={op.tuneVIn}
            setTuneVIn={op.setTuneVIn}
            loadVIn={op.loadVIn}
            setLoadVIn={op.setLoadVIn}
            applyTuneVolts={op.applyTuneVolts}
            applyLoadVolts={op.applyLoadVolts}
            sendTune={op.sendTune}
            sendLoad={op.sendLoad}
            bumpTune={op.bumpTune}
            bumpLoad={op.bumpLoad}
            activeCap={op.activeCap}
            setActiveCap={op.setActiveCap}
            bumpActive={op.bumpActive}
            presets={op.presets}
            presetEntries={op.presetEntries}
            saveSlot={op.saveSlot}
            setSaveSlot={op.setSaveSlot}
            savePreset={op.savePreset}
            clearPreset={op.clearPreset}
            recallPreset={op.recallPreset}
          />

          <MatchTunerPanel
            controllable={op.controllable}
            t={op.t}
            mt={op.mt}
            setMatchMode={op.setMatchMode}
            startMatchTuner={op.startMatchTuner}
            stopMatchTuner={op.stopMatchTuner}
            armMatchTuner={op.armMatchTuner}
            disarmMatchTuner={op.disarmMatchTuner}
            revPct={op.revPct}
            fmtDelta={op.fmtDelta}
          />

          <section className="panel calib-slot">
            <h2>Calibration</h2>
            <div className="hint">
              Reserved for the calibration routine — step tests, <code>calibration.json</code> status,
              and per-session absorbed-power identification.
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
