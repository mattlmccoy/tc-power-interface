import type { RampStatus, Telemetry } from "../lib/telemetry.ts";
import { fmtWatts } from "../lib/format.ts";
import { Gauge } from "./Gauge.tsx";
import { StatusLeds } from "./StatusLeds.tsx";

interface TelemetryPanelProps {
  showGauges: boolean;
  toggleGauges: (on: boolean) => void;
  ramp: RampStatus | undefined;
  requested: number | null;
  t: Telemetry | null;
  powerCeil: number;
  maxRefl: number;
  fwdCaution: number | null;
  fwdDanger: number | null;
  zone: string;
}

export function TelemetryPanel(props: TelemetryPanelProps) {
  const {
    showGauges, toggleGauges, ramp, requested, t, powerCeil, maxRefl, fwdCaution, fwdDanger, zone,
  } = props;
  return (
            <section className="panel">
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <h2 style={{ margin: 0 }}>Telemetry</h2>
                  {ramp?.running ? (
                    <span className="ramp-badge">
                      ▲ R · ramping → {ramp.target_w} W @ {ramp.rate_w_per_s} W/s
                    </span>
                  ) : null}
                </div>
                <label className="toggle" style={{ margin: 0, fontSize: "12px" }}>
                  <input
                    type="checkbox"
                    checked={showGauges}
                    onChange={(e) => toggleGauges(e.target.checked)}
                  />
                  Analog gauges
                </label>
              </div>
              {showGauges ? (
                <div className="gauge-grid" style={{ marginTop: "10px" }}>
                  <Gauge
                    label="Requested"
                    value={requested}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                  <Gauge
                    label="Forward"
                    value={t ? t.forward_w : null}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                  <Gauge
                    label="Load"
                    value={t ? t.load_w : null}
                    max={powerCeil}
                    caution={fwdCaution}
                    danger={fwdDanger}
                  />
                  <Gauge
                    label="Reverse"
                    value={t ? t.reverse_w : null}
                    max={maxRefl}
                    caution={maxRefl * 0.5}
                    danger={maxRefl * 0.8}
                  />
                </div>
              ) : (
                <div className="cards" style={{ marginTop: "10px" }}>
                  <div className="readout">
                    <div className="label">Requested</div>
                    <div className="value">{requested === null ? "—" : fmtWatts(requested)}</div>
                  </div>
                  <div className="readout">
                    <div className="label">Forward power</div>
                    <div className={`value ${t?.rf_on ? "rf-on" : ""}`}>
                      {t ? fmtWatts(t.forward_w) : "—"}
                    </div>
                  </div>
                  <div className="readout">
                    <div className="label">Load power</div>
                    <div className="value">{t ? fmtWatts(t.load_w) : "—"}</div>
                  </div>
                  <div className={`readout zone-${zone}`}>
                    <div className="label">Reverse power</div>
                    <div className="value">{t ? fmtWatts(t.reverse_w) : "—"}</div>
                  </div>
                </div>
              )}
              <div style={{ marginTop: "10px" }}>
                <StatusLeds status={t ? t.status : null} />
              </div>
              <div className="hint mono">
                RF {t?.rf_on ? "ON" : "off"} · mode {t?.operation_mode ?? "—"} · tuner{" "}
                {t?.tuner ?? "—"}
              </div>
            </section>
  );
}
