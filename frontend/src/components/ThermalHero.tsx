import type { Operator } from "../hooks/useOperator.ts";
import { PHASES, phaseIndex } from "../lib/thermalView.ts";
import { ThermalControls } from "./ThermalControls.tsx";
import { ThermalTrace } from "./ThermalTrace.tsx";

export function ThermalHero({ op }: { op: Operator }) {
  const { thermal, heroTrace, roiTrace, showRoiOverlay, toggleRoiOverlay } = op;
  const idx = phaseIndex(thermal?.phase ?? "");
  const bandC = op.thermalPlanStatus?.approach_band_c ?? 15;
  const targetC = thermal?.target_c ?? 185;
  return (
    <section className="panel hero">
      <div className="hero-head">
        <h2>Closed-loop thermal control</h2>
        <label className="toggle" style={{ margin: 0, fontSize: "12px" }}>
          <input
            type="checkbox"
            checked={showRoiOverlay}
            onChange={(e) => toggleRoiOverlay(e.target.checked)}
          />
          Other ROIs
        </label>
      </div>
      <div className="phase-strip">
        {PHASES.map((p, i) => (
          <span key={p} className={`ph ${i === idx ? "on" : ""} ${idx >= 0 && i < idx ? "done" : ""}`}>
            {p.toUpperCase()}
          </span>
        ))}
      </div>
      <div className="hero-body">
        <ThermalTrace
          control={heroTrace.control}
          max={heroTrace.max}
          roi={roiTrace}
          showOverlay={showRoiOverlay}
          targetC={targetC}
          bandC={bandC}
        />
        <ThermalControls
          controllable={op.controllable}
          connected={op.connected}
          t={op.t}
          thermal={op.thermal}
          controlMaxC={op.thermal?.control_max_c}
          thermalMode={op.thermalMode}
          setThermalMode={op.setThermalMode}
          thermalFlirUrl={op.thermalFlirUrl}
          setThermalFlirUrl={op.setThermalFlirUrl}
          startThermal={op.startThermal}
          stopThermal={op.stopThermal}
          armThermal={op.armThermal}
          disarmThermal={op.disarmThermal}
          applyThermalSource={op.applyThermalSource}
          applyControlRoi={op.applyControlRoi}
          onEditPlan={() => op.setView("settings")}
          textInputStyle={op.textInputStyle}
        />
      </div>
    </section>
  );
}
