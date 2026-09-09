import type { ThermalPlanStatus } from "../lib/telemetry.ts";
import { boundHint } from "../lib/format.ts";

type ThermalPlanFormState = {
  target_c: string;
  soak_s: string;
  approach_band_c: string;
  loop_ceiling_w: string;
  max_step_w: string;
  done_below_c: string;
};

interface ThermalPlanPanelProps {
  thermalPlanStatus: ThermalPlanStatus | null;
  thermalForm: ThermalPlanFormState;
  setThermalForm: (v: ThermalPlanFormState) => void;
  saveThermalPlan: () => void;
}

export function ThermalPlanPanel(props: ThermalPlanPanelProps) {
  const { thermalPlanStatus, thermalForm, setThermalForm, saveThermalPlan } = props;
  return (
            <section className="panel">
              <h2>Thermal plan</h2>
              {thermalPlanStatus ? (
                <>
                  <div className="hint">
                    The closed-loop trajectory (ramp → approach → soak → cool). The loop ceiling is
                    additionally clamped to the max forward power. Values are clamped to the hard
                    bounds shown.
                  </div>
                  <label className="field-label">
                    Target temperature (°C){boundHint(thermalPlanStatus.bounds, "target_c")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.target_c}
                    onChange={(e) => setThermalForm({ ...thermalForm, target_c: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Soak time (s){boundHint(thermalPlanStatus.bounds, "soak_s")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.soak_s}
                    onChange={(e) => setThermalForm({ ...thermalForm, soak_s: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Loop ceiling (W){boundHint(thermalPlanStatus.bounds, "loop_ceiling_w")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.loop_ceiling_w}
                    onChange={(e) =>
                      setThermalForm({ ...thermalForm, loop_ceiling_w: e.target.value })
                    }
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Approach band (°C){boundHint(thermalPlanStatus.bounds, "approach_band_c")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.approach_band_c}
                    onChange={(e) =>
                      setThermalForm({ ...thermalForm, approach_band_c: e.target.value })
                    }
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Max step (W per tick){boundHint(thermalPlanStatus.bounds, "max_step_w")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.max_step_w}
                    onChange={(e) => setThermalForm({ ...thermalForm, max_step_w: e.target.value })}
                  />
                  <label className="field-label" style={{ marginTop: "10px" }}>
                    Done-below temperature (°C){boundHint(thermalPlanStatus.bounds, "done_below_c")}
                  </label>
                  <input
                    type="number"
                    value={thermalForm.done_below_c}
                    onChange={(e) => setThermalForm({ ...thermalForm, done_below_c: e.target.value })}
                  />
                  <button
                    className="btn accent full"
                    style={{ marginTop: "12px" }}
                    onClick={saveThermalPlan}
                  >
                    Save thermal plan
                  </button>
                </>
              ) : (
                <div className="muted">loading…</div>
              )}
            </section>
  );
}
