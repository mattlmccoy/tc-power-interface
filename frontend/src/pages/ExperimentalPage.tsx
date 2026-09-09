import type { Operator } from "../hooks/useOperator.ts";
import { PulsePanel } from "../components/PulsePanel.tsx";
import { ThermalControlPanel } from "../components/ThermalControlPanel.tsx";

export function ExperimentalPage({ op }: { op: Operator }) {
  const { applyControlRoi, applyThermalSource, armThermal, connected, controllable, disarmThermal, pulse, pulseForm, setPulseForm, setThermalFlirUrl, setThermalMode, startPulse, startThermal, stopPulse, stopThermal, t, textInputStyle, thermal, thermalFlirUrl, thermalMode } = op;
  return (
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
  );
}
