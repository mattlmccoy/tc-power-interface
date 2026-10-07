import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import type { Operator } from "../hooks/useOperator.ts";
import { DashPanel } from "../components/DashPanel.tsx";
import type { DropWhere } from "../components/DashPanel.tsx";
import { GeneratorPanel } from "../components/GeneratorPanel.tsx";
import { HistoryPanel } from "../components/HistoryPanel.tsx";
import { MatchingNetworkPanel } from "../components/MatchingNetworkPanel.tsx";
import { MatchTunerPanel } from "../components/MatchTunerPanel.tsx";
import { MatchAidPanel } from "../components/MatchAidPanel.tsx";
import type { MatchAid } from "../hooks/useMatchAid.ts";
import { RecordingPanel } from "../components/RecordingPanel.tsx";
import { RfPowerPanel } from "../components/RfPowerPanel.tsx";
import { TelemetryPanel } from "../components/TelemetryPanel.tsx";
import { SenseLoopPanel } from "../components/SenseLoopPanel.tsx";
import { TimerPanel } from "../components/TimerPanel.tsx";
import {
  loadLayout,
  movePanel,
  resetLayout,
  saveLayout,
  toggleCollapsed,
} from "../lib/layout.ts";
import type { Column, Layout, PanelId } from "../lib/layout.ts";
import {
  generatorSummary, matchAidSummary, matchNetSummary, matchTunerSummary, recordingSummary,
  rfPowerSummary, senseLoopSummary, telemetrySummary, timerSummary,
} from "../lib/panelSummaries.ts";
import type { Segment } from "../lib/panelSummaries.ts";
import { settingsStorage } from "../lib/settings_store.ts";

interface PanelEntry {
  title: string;
  el: ReactNode;
  summary?: Segment[];
}

export function DashboardPage({ op, aid }: { op: Operator; aid: MatchAid }) {
  const { activeCap, applyLoadVolts, applySetpoint, applyTuneVolts, armDevice, armMatchTuner, armed, bumpActive, bumpLoad, bumpTune, capBusy, clearPreset, connected, controllable, device, disarmDevice, disarmMatchTuner, estop, faulted, flash, fmtDelta, fwdCaution, fwdDanger, lastRun, limits, load, loadVIn, maxRefl, mt, nudgeSetpoint, onSetpointKey, plot, powerCeil, presetEntries, presets, ramp, rampForm, recallPreset, recording, reflFillPct, requested, revPct, rfOff, rfOn, runName, savePreset, saveSlot, sendLoad, sendTune, setActiveCap, setLoadVIn, setMatchMode, setRampForm, setRunName, setSaveSlot, setSetpointInput, setTimerMin, setTuneVIn, setpointInput, setpointRef, showGauges, startMatchTuner, startRamp, startTimer, stopMatchTuner, stopRamp, stopTimer, t, textInputStyle, timer, timerMin, toggleGauges, tune, tuneVIn, zone } = op;
  const [layout, setLayout] = useState<Layout>(() => loadLayout(settingsStorage()));
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const [mark, setMark] = useState<{ id: PanelId; where: DropWhere } | null>(null);

  const update = useCallback((l: Layout) => {
    setLayout(l);
    saveLayout(settingsStorage(), l);
  }, []);
  const endDrag = () => {
    setDragId(null);
    setMark(null);
  };
  const markAt = (id: PanelId, where: DropWhere) =>
    setMark((m) => (m && m.id === id && m.where === where ? m : { id, where }));

  // PanelId -> element. Each `el` is the panel JSX exactly as it was laid out before.
  const panels: Record<PanelId, PanelEntry> = {
    telemetry: {
      title: "Telemetry",
      el: (
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
      ),
      summary: telemetrySummary(t, zone),
    },
    rfpower: {
      title: "RF power",
      el: (
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
      ),
      summary: rfPowerSummary({
        connected, armed, faulted, rfOn: t ? t.rf_on : null, setpointW: op.ctrl?.last_setpoint_w, ramp,
      }),
    },
    generator: {
      title: "Generator",
      el: (
        <GeneratorPanel t={t} limits={limits} device={device} />
      ),
      summary: generatorSummary(t, limits),
    },
    history: {
      title: "History",
      el: (
        <HistoryPanel plot={plot} powerCeil={powerCeil} />
      ),
    },
    senseloop: {
      title: "Sense loop",
      el: (
        <SenseLoopPanel scope={op.scope} />
      ),
      summary: senseLoopSummary(op.scope),
    },
    matchnet: {
      title: "Matching network",
      el: (
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
      ),
      summary: matchNetSummary(t),
    },
    matchaid: {
      title: "Match aid",
      el: (
        <MatchAidPanel aid={aid} t={t} />
      ),
      summary: matchAidSummary(aid),
    },
    matchtuner: {
      title: "Match tuner",
      el: (
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
      ),
      summary: matchTunerSummary(mt),
    },
    timer: {
      title: "Auto-shutoff timer",
      el: (
        <TimerPanel
          controllable={controllable}
          timer={timer}
          timerMin={timerMin}
          setTimerMin={setTimerMin}
          startTimer={startTimer}
          stopTimer={stopTimer}
        />
      ),
      summary: timerSummary(timer),
    },
    recording: {
      title: "Recording",
      el: (
        <RecordingPanel
          controllable={controllable}
          recording={recording}
          lastRun={lastRun}
          runName={runName}
          setRunName={setRunName}
          flash={flash}
          textInputStyle={textInputStyle}
        />
      ),
      // Re-rendered on every status poll, so the elapsed time ticks with the telemetry.
      summary: recordingSummary(recording, Date.now()),
    },
  };

  const renderCol = (col: Column) => (
    <div className="col" key={col}>
      {layout[col].map((id) => (
        <DashPanel
          key={id}
          id={id}
          title={panels[id].title}
          collapsed={layout.collapsed.includes(id)}
          summary={panels[id].summary}
          dragging={dragId === id}
          dropMark={mark?.id === id && dragId !== null && dragId !== id ? mark.where : null}
          onToggle={(pid) => update(toggleCollapsed(layout, pid))}
          onDragStart={setDragId}
          onDragEnd={endDrag}
          onDragOverPanel={markAt}
          onDropPanel={(pid, where) => {
            if (!dragId || dragId === pid) return endDrag();
            const targetCol: Column = layout.left.includes(pid) ? "left" : "right";
            const without = layout[targetCol].filter((x) => x !== dragId);
            const idx = without.indexOf(pid) + (where === "after" ? 1 : 0);
            update(movePanel(layout, dragId, targetCol, idx));
            endDrag();
          }}
        >
          {panels[id].el}
        </DashPanel>
      ))}
      <div
        className={`col-tail${dragId && mark === null ? " drop-target" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setMark(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId) update(movePanel(layout, dragId, col, layout[col].length));
          endDrag();
        }}
      />
    </div>
  );

  return (
    <div className="main">
      {renderCol("left")}
      {renderCol("right")}
      <div className="layout-reset">
        <button type="button" onClick={() => update(resetLayout())} title="Restore the default panel arrangement">
          Reset layout
        </button>
      </div>
    </div>
  );
}
