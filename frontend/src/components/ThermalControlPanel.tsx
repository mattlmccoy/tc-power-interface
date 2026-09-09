import type { CSSProperties } from "react";
import type { Telemetry, ThermalStatus } from "../lib/telemetry.ts";
import { fmtTemp, fmtWatts } from "../lib/format.ts";

interface ThermalControlPanelProps {
  controllable: boolean;
  connected: boolean;
  t: Telemetry | null;
  thermal: ThermalStatus | undefined;
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
  textInputStyle: CSSProperties;
}

export function ThermalControlPanel(props: ThermalControlPanelProps) {
  const {
    controllable, connected, t, thermal, thermalMode, setThermalMode, thermalFlirUrl,
    setThermalFlirUrl, startThermal, stopThermal, armThermal, disarmThermal, applyThermalSource,
    applyControlRoi, textInputStyle,
  } = props;
  return (
                  <section className="panel">
                    <h2>Thermal control (closed loop)</h2>
                    <div className="banner warn help-text" style={{ margin: "0 0 12px" }}>
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
                            {/* If the selected ROI has left the live feed, still show it, flagged. */}
                            {thermal?.control_roi &&
                            !(thermal?.available_rois ?? []).includes(thermal.control_roi) &&
                            (thermal?.available_rois?.length ?? 0) > 0 ? (
                              <option value={thermal.control_roi}>
                                {thermal.control_roi} (not in live feed)
                              </option>
                            ) : null}
                            {(thermal?.available_rois ?? []).map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="hint">
                          Loop controls on this ROI's mean temp. ROIs come from FLIR and change
                          print-to-print; if the selected one leaves the feed, the loop holds 0&nbsp;W.
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
                        <button
                          className="btn accent full"
                          onClick={startThermal}
                          disabled={!controllable}
                        >
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
  );
}
