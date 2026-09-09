import type { DeviceInfo, Limits, Telemetry } from "../lib/telemetry.ts";
import { fmtTemp } from "../lib/format.ts";
import { generatorModes, tempBar } from "../lib/instrument.ts";

interface GeneratorPanelProps {
  t: Telemetry | null;
  limits: Limits | undefined;
  device: DeviceInfo | undefined;
}

export function GeneratorPanel({ t, limits, device }: GeneratorPanelProps) {
  return (
            <section className="panel gen-panel">
              <h2>Generator</h2>
              <div className="readout" style={{ marginBottom: "8px" }}>
                <div className="label">Internal temperature</div>
                <div className="temp-row">
                  <div className="value">{t ? fmtTemp(t.temperature_c) : "—"}</div>
                  {t && limits ? (
                    <div className="temp-bar-wrap">
                      <div className="temp-bar">
                        <div
                          className="temp-bar-fill"
                          style={{
                            width: `${tempBar(t.temperature_c, 25, limits.temperature_c_trip).fraction * 100}%`,
                            background: tempBar(t.temperature_c, 25, limits.temperature_c_trip)
                              .color,
                          }}
                        />
                      </div>
                      <div className="temp-bar-legend">
                        <span>25 °C</span>
                        <span>trip {limits.temperature_c_trip.toFixed(0)} °C</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="cards">
                <div className="readout">
                  <div className="label">DC probe (bias)</div>
                  <div className="value">
                    {t?.dc_voltage != null ? `${t.dc_voltage.toFixed(0)} V` : "—"}
                  </div>
                </div>
                <div className="readout">
                  <div className="label">Preset</div>
                  <div className="value">{t?.preset_slot ? `#${t.preset_slot}` : "—"}</div>
                </div>
                <div className="readout">
                  <div className="label">RF source</div>
                  <div className="value">{t ? generatorModes(t.status).rfSource : "—"}</div>
                </div>
                <div className="readout">
                  <div className="label">Leveling</div>
                  <div className="value">{t ? generatorModes(t.status).leveling : "—"}</div>
                </div>
              </div>
              <div className="hint">
                <strong>DC probe</strong> = plasma self-bias measured through the tuner (0–999 V).
                ~0 V is expected here: a dielectric load (powder between plates) is not a plasma, so
                no sheath rectifies a DC self-bias — match quality shows up in forward/reflected
                power, not DC. A nonzero reading would signal arcing or a partial discharge.
              </div>
              <div className="hint">
                Frequency {device?.frequency_hz ? (device.frequency_hz / 1e6).toFixed(2) : "—"} MHz ·
                mode {t?.operation_mode ?? "—"}. Read-only — preset / RF-source / leveling writes need
                the verified CXN command set (deferred; the real unit's CXN support is unconfirmed).
              </div>
            </section>
  );
}
