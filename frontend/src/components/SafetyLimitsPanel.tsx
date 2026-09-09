import type { SafetyLimitsStatus } from "../lib/telemetry.ts";
import { boundHint } from "../lib/format.ts";

type SafetyLimitsFormState = {
  max_forward_w: string;
  max_reflected_w: string;
  temperature_c_trip: string;
  forward_caution_w: string;
  forward_danger_w: string;
};

interface SafetyLimitsPanelProps {
  limitsStatus: SafetyLimitsStatus | null;
  limForm: SafetyLimitsFormState;
  setLimForm: (v: SafetyLimitsFormState) => void;
  saveLimits: () => void;
}

export function SafetyLimitsPanel(props: SafetyLimitsPanelProps) {
  const { limitsStatus, limForm, setLimForm, saveLimits } = props;
  return (
            <section className="panel">
              <h2>Safety limits</h2>
              {limitsStatus ? (
                <>
                  <div className="hint">
                    Protection thresholds. You can always tighten; values are clamped to the hard
                    bounds shown and take effect on the next telemetry poll.
                  </div>
                  <label className="field-label">
                    Max forward power (W){boundHint(limitsStatus.bounds, "max_forward_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.max_forward_w}
                    onChange={(e) => setLimForm({ ...limForm, max_forward_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Max reflected power / trip (W){boundHint(limitsStatus.bounds, "max_reflected_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.max_reflected_w}
                    onChange={(e) => setLimForm({ ...limForm, max_reflected_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Over-temperature shutoff (°C){boundHint(limitsStatus.bounds, "temperature_c_trip")}
                  </label>
                  <input
                    type="number"
                    value={limForm.temperature_c_trip}
                    onChange={(e) => setLimForm({ ...limForm, temperature_c_trip: e.target.value })}
                  />
                  <div className="hint" style={{ marginTop: "12px" }}>
                    Gauge zones (display only — the forward power dials shade at these watts; they do
                    not change protection).
                  </div>
                  <label className="field-label" style={{ marginTop: "8px" }}>
                    Caution — yellow from (W){boundHint(limitsStatus.bounds, "forward_caution_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.forward_caution_w}
                    onChange={(e) => setLimForm({ ...limForm, forward_caution_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Danger — red from (W){boundHint(limitsStatus.bounds, "forward_danger_w")}
                  </label>
                  <input
                    type="number"
                    value={limForm.forward_danger_w}
                    onChange={(e) => setLimForm({ ...limForm, forward_danger_w: e.target.value })}
                  />
                  <button
                    className="btn accent full"
                    style={{ marginTop: "12px" }}
                    onClick={saveLimits}
                  >
                    Save limits
                  </button>
                </>
              ) : (
                <div className="muted">loading…</div>
              )}
            </section>
  );
}
