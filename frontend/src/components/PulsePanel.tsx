import type { PulseStatus } from "../lib/telemetry.ts";

interface PulsePanelProps {
  controllable: boolean;
  pulse: PulseStatus | undefined;
  pulseForm: { on_ms: string; off_ms: string; power_w: string };
  setPulseForm: (v: PulsePanelProps["pulseForm"]) => void;
  startPulse: () => void;
  stopPulse: () => void;
}

export function PulsePanel(props: PulsePanelProps) {
  const { controllable, pulse, pulseForm, setPulseForm, startPulse, stopPulse } = props;
  return (
                  <section className="panel">
                    <h2>Pulse mode</h2>
                    <div className="banner warn help-text" style={{ margin: "0 0 12px" }}>
                      <strong>Experimental — simulator only.</strong> Models the generator's PULSE
                      waveform by gating the setpoint on/off; it never enables RF. The real unit's
                      PULSE serial command is unverified, so this is not wired to hardware yet.
                    </div>
                    <div className="ramp-grid">
                      <label className="ramp-field">
                        <span>Time on (ms)</span>
                        <input
                          type="number"
                          min={1}
                          max={9995}
                          value={pulseForm.on_ms}
                          disabled={pulse?.running}
                          onChange={(e) => setPulseForm({ ...pulseForm, on_ms: e.target.value })}
                        />
                      </label>
                      <label className="ramp-field">
                        <span>Time off (ms)</span>
                        <input
                          type="number"
                          min={1}
                          max={9995}
                          value={pulseForm.off_ms}
                          disabled={pulse?.running}
                          onChange={(e) => setPulseForm({ ...pulseForm, off_ms: e.target.value })}
                        />
                      </label>
                      <label className="ramp-field">
                        <span>Power (W)</span>
                        <input
                          type="number"
                          min={0}
                          value={pulseForm.power_w}
                          disabled={pulse?.running}
                          onChange={(e) => setPulseForm({ ...pulseForm, power_w: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className="ramp-actions">
                      {pulse?.running ? (
                        <button className="btn" onClick={stopPulse}>
                          Stop pulse
                        </button>
                      ) : (
                        <button className="btn accent" onClick={startPulse} disabled={!controllable}>
                          Start pulse
                        </button>
                      )}
                      <span className="hint mono" style={{ margin: 0 }}>
                        duty {pulse ? Math.round(pulse.duty * 100) : "—"}%
                        {pulse?.running ? ` · ${pulse.output_on ? "ON" : "off"}` : ""}
                      </span>
                    </div>
                  </section>
  );
}
