import type { CSSProperties } from "react";

import { fmtTemp, fmtWatts } from "../lib/format.ts";
import type { Telemetry, ThermalStatus } from "../lib/telemetry.ts";
import { appliedLabel, overTempGuard } from "../lib/thermalView.ts";

interface ThermalControlsProps {
  controllable: boolean;
  connected: boolean;
  t: Telemetry | null;
  thermal: ThermalStatus | undefined;
  controlMaxC: number | null | undefined;
  thermalMode: "advisory" | "auto";
  setThermalMode: (v: "advisory" | "auto") => void;
  thermalFlirUrl: string;
  setThermalFlirUrl: (v: string) => void;
  startThermal: () => void;
  stopThermal: () => void;
  armThermal: () => void;
  disarmThermal: () => void;
  applyThermalSource: (t: "simulated" | "flir") => void;
  applyControlRoi: (name: string) => void;
  onEditPlan: () => void;
  textInputStyle: CSSProperties;
}

export function ThermalControls(props: ThermalControlsProps) {
  const {
    controllable, connected, t, thermal, controlMaxC, thermalMode, setThermalMode, thermalFlirUrl,
    setThermalFlirUrl, startThermal, stopThermal, armThermal, disarmThermal, applyThermalSource,
    applyControlRoi, onEditPlan, textInputStyle,
  } = props;
  const guard = overTempGuard(controlMaxC);
  return (
    <div className="hero-controls">
      {/* Dormant over-temp abort seam — arms with the calibration/abort sub-project (never a false OK). */}
      <div className="abort-slot dormant">over-temp abort — arms with the calibration build</div>

      <div className="cards">
        <div className="readout">
          <div className="label">Control temp → target</div>
          <div className={`value ${thermal?.running ? "rf-on" : ""}`}>
            {thermal ? `${fmtTemp(thermal.control_temp_c)} → ${fmtTemp(thermal.target_c)}` : "—"}
          </div>
        </div>
        <div className="readout">
          <div className="label">Recommended → applied</div>
          <div className="value">
            {thermal ? `${fmtWatts(thermal.recommended_w)} → ${appliedLabel(thermal.applied_w)}` : "—"}
          </div>
        </div>
      </div>
      <div className="hint mono">
        ROI max {guard.kind === "value" ? fmtTemp(guard.maxC) : "not reported"}
      </div>

      <label className="field-label" style={{ marginTop: "12px" }}>
        Temperature source
      </label>
      <div className="row">
        <select
          value={thermal?.source ?? "simulated"}
          onChange={(e) => applyThermalSource(e.target.value as "simulated" | "flir")}
          disabled={!controllable}
        >
          <option value="simulated">simulated model</option>
          <option value="flir">FLIR stream</option>
        </select>
      </div>
      {(thermal?.source ?? "simulated") === "flir" ? (
        <>
          <input
            className="mono"
            style={textInputStyle}
            placeholder="http://127.0.0.1:8000"
            value={thermalFlirUrl}
            onChange={(e) => setThermalFlirUrl(e.target.value)}
            onBlur={() => applyThermalSource("flir")}
          />
          <label className="field-label" style={{ marginTop: "8px" }}>
            Control ROI
          </label>
          <div className="row">
            <select
              value={thermal?.control_roi ?? ""}
              onChange={(e) => applyControlRoi(e.target.value)}
              disabled={!controllable || (thermal?.available_rois?.length ?? 0) === 0}
            >
              {(thermal?.available_rois?.length ?? 0) === 0 ? (
                <option value="">no live ROIs — draw one in FLIR</option>
              ) : null}
              {thermal?.control_roi &&
              !(thermal?.available_rois ?? []).includes(thermal.control_roi) &&
              (thermal?.available_rois?.length ?? 0) > 0 ? (
                <option value={thermal.control_roi}>{thermal.control_roi} (not in live feed)</option>
              ) : null}
              {(thermal?.available_rois ?? []).map((rr) => (
                <option key={rr} value={rr}>
                  {rr}
                </option>
              ))}
            </select>
          </div>
          <div className="hint">
            Loop controls on this ROI's mean temp. ROIs come from FLIR and change print-to-print; if
            the selected one leaves the feed, the loop holds 0&nbsp;W.
          </div>
        </>
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
          <button className="btn accent full" onClick={startThermal} disabled={!controllable}>
            Start loop
          </button>
        )}
      </div>
      <div className="row" style={{ marginTop: "8px" }}>
        <button
          className="btn full"
          onClick={armThermal}
          disabled={!controllable || !t?.rf_on || thermal?.armed}
        >
          {thermal?.armed ? "LOOP ARMED" : "ARM LOOP"}
        </button>
        <button className="btn full" onClick={disarmThermal} disabled={!connected || !thermal?.armed}>
          DISARM LOOP
        </button>
      </div>
      <div className="plan-summary hint">
        Plan target {thermal ? fmtTemp(thermal.target_c) : "—"} · auto drives the RF <em>setpoint</em>{" "}
        within the plan ceiling; a fault or RF-off disarms.{" "}
        <button className="linklike" onClick={onEditPlan}>
          edit plan ▸
        </button>
      </div>
    </div>
  );
}
