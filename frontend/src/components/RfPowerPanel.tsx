import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import type { Limits, RampStatus, Telemetry } from "../lib/telemetry.ts";
import { fmtWatts } from "../lib/format.ts";
import { SetpointEntry } from "./cockpit/SetpointEntry.tsx";


interface RfPowerPanelProps {
  connected: boolean;
  armed: boolean;
  controllable: boolean;
  faulted: boolean;
  estop: () => void;
  armDevice: () => void;
  disarmDevice: () => void;
  rfOn: () => void;
  rfOff: () => void;
  setpointInput: string;
  setSetpointInput: (v: string) => void;
  setpointRef: MutableRefObject<number>;
  applySetpoint: () => void;
  nudgeSetpoint: (d: number) => void;
  onSetpointKey: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  limits: Limits | undefined;
  ramp: RampStatus | undefined;
  rampForm: { init_w: string; target_w: string; rate_w_per_s: string };
  setRampForm: (v: RfPowerPanelProps["rampForm"]) => void;
  startRamp: () => void;
  stopRamp: () => void;
  t: Telemetry | null;
  zone: string;
  reflFillPct: number;
  maxRefl: number;
}

export function RfPowerPanel(props: RfPowerPanelProps) {
  const {
    connected, armed, controllable, faulted, estop, armDevice, disarmDevice, rfOn, rfOff,
    setpointInput, setSetpointInput, setpointRef, applySetpoint, nudgeSetpoint, onSetpointKey,
    limits, ramp, rampForm, setRampForm, startRamp, stopRamp, t, zone, reflFillPct, maxRefl,
  } = props;
  return (
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
                  <SetpointEntry
                    controllable={controllable}
                    setpointInput={setpointInput}
                    setSetpointInput={setSetpointInput}
                    setpointRef={setpointRef}
                    applySetpoint={applySetpoint}
                    nudgeSetpoint={nudgeSetpoint}
                    onSetpointKey={onSetpointKey}
                    ceilingW={limits?.max_forward_w ?? null}
                  />
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
  );
}
