import type { PresetSlot, PresetsStatus, Telemetry } from "../lib/telemetry.ts";
import { capVolts, LOAD_CAL, TUNE_CAL } from "../lib/instrument.ts";

interface MatchingNetworkPanelProps {
  controllable: boolean;
  capBusy: null | "tune" | "load";
  tune: number;
  load: number;
  t: Telemetry | null;
  tuneVIn: string;
  setTuneVIn: (v: string) => void;
  loadVIn: string;
  setLoadVIn: (v: string) => void;
  applyTuneVolts: () => void;
  applyLoadVolts: () => void;
  sendTune: (v: number) => void;
  sendLoad: (v: number) => void;
  bumpTune: (d: number) => void;
  bumpLoad: (d: number) => void;
  activeCap: "tune" | "load";
  setActiveCap: (c: "tune" | "load") => void;
  bumpActive: (d: number) => void;
  presets: PresetsStatus | undefined;
  presetEntries: (readonly [number, PresetSlot])[];
  saveSlot: string;
  setSaveSlot: (v: string) => void;
  savePreset: (n: number) => void;
  clearPreset: (n: number) => void;
  recallPreset: (n: number) => void;
}

export function MatchingNetworkPanel(props: MatchingNetworkPanelProps) {
  const {
    controllable, capBusy, tune, load, t, tuneVIn, setTuneVIn, loadVIn, setLoadVIn, applyTuneVolts,
    applyLoadVolts, sendTune, sendLoad, bumpTune, bumpLoad, activeCap, setActiveCap, bumpActive,
    presets, presetEntries, saveSlot, setSaveSlot, savePreset, clearPreset, recallPreset,
  } = props;
  return (
            <section className="panel">
              <h2>Matching network</h2>
              <div className="lock-badge">
                🔒 Manual tuning — locked on.
                <span className="help-text"> The built-in auto-tuner (ATUNE) is never engaged.</span>
              </div>
              <div className="hint" style={{ marginTop: "6px" }}>
                Set a cap to a target VNA voltage (snaps to the nearest whole percent — the
                generator's 1% resolution). Set always lands from below to cancel the AIT's
                backlash, so it takes a few seconds. Or nudge % with −/+.
              </div>

              {/* Tune cap: voltage-primary, whole-percent steppers */}
              <div className="cap-row cap-head" style={{ marginTop: "10px" }}>
                <span className="cap-name">Tune cap</span>
                <span className="cap-now">
                  {tune}% · {capVolts(tune, TUNE_CAL).toFixed(2)} V
                </span>
                <span className="cap-readback">
                  act{" "}
                  {t?.tune_cap_percent != null
                    ? `${t.tune_cap_percent.toFixed(1)}% · ${capVolts(t.tune_cap_percent, TUNE_CAL).toFixed(2)} V`
                    : "—"}
                </span>
              </div>
              <div className="cap-ctl">
                <input
                  type="number"
                  className="cap-v-input"
                  step={0.01}
                  placeholder="target"
                  value={tuneVIn}
                  disabled={!controllable || capBusy === "tune"}
                  onChange={(e) => setTuneVIn(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyTuneVolts()}
                />
                <span className="cap-vunit">V</span>
                <button className="btn" onClick={applyTuneVolts} disabled={!controllable || capBusy === "tune"}>
                  {capBusy === "tune" ? "Set…" : "Set"}
                </button>
                <span className="cap-ctl-gap" />
                <button className="btn step-btn" onClick={() => bumpTune(-1)} disabled={!controllable || capBusy === "tune"}>
                  −
                </button>
                <span className="cap-pct">{tune}%</span>
                <button className="btn step-btn" onClick={() => bumpTune(1)} disabled={!controllable || capBusy === "tune"}>
                  +
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={tune}
                disabled={!controllable || capBusy === "tune"}
                onChange={(e) => sendTune(Number(e.target.value))}
              />

              {/* Load cap */}
              <div className="cap-row cap-head" style={{ marginTop: "14px" }}>
                <span className="cap-name">Load cap</span>
                <span className="cap-now">
                  {load}% · {capVolts(load, LOAD_CAL).toFixed(2)} V
                </span>
                <span className="cap-readback">
                  act{" "}
                  {t?.load_cap_percent != null
                    ? `${t.load_cap_percent.toFixed(1)}% · ${capVolts(t.load_cap_percent, LOAD_CAL).toFixed(2)} V`
                    : "—"}
                </span>
              </div>
              <div className="cap-ctl">
                <input
                  type="number"
                  className="cap-v-input"
                  step={0.01}
                  placeholder="target"
                  value={loadVIn}
                  disabled={!controllable || capBusy === "load"}
                  onChange={(e) => setLoadVIn(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyLoadVolts()}
                />
                <span className="cap-vunit">V</span>
                <button className="btn" onClick={applyLoadVolts} disabled={!controllable || capBusy === "load"}>
                  {capBusy === "load" ? "Set…" : "Set"}
                </button>
                <span className="cap-ctl-gap" />
                <button className="btn step-btn" onClick={() => bumpLoad(-1)} disabled={!controllable || capBusy === "load"}>
                  −
                </button>
                <span className="cap-pct">{load}%</span>
                <button className="btn step-btn" onClick={() => bumpLoad(1)} disabled={!controllable || capBusy === "load"}>
                  +
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={load}
                disabled={!controllable || capBusy === "load"}
                onChange={(e) => sendLoad(Number(e.target.value))}
              />

              {/* MODE: in manual tuning, choose which cap the shared fine −/+ act on (the AG Plasma
                  front-panel MODE button toggles LC/TC in MTUNE for faster tuning). */}
              <div className="mode-row">
                <span className="cap-name">MODE</span>
                <div className="seg">
                  <button
                    className={activeCap === "tune" ? "seg-btn on" : "seg-btn"}
                    disabled={!controllable}
                    onClick={() => setActiveCap("tune")}
                  >
                    TUNE
                  </button>
                  <button
                    className={activeCap === "load" ? "seg-btn on" : "seg-btn"}
                    disabled={!controllable}
                    onClick={() => setActiveCap("load")}
                  >
                    LOAD
                  </button>
                </div>
                <button
                  className="btn step-btn"
                  disabled={!controllable}
                  onClick={() => bumpActive(-1)}
                >
                  −
                </button>
                <button
                  className="btn step-btn"
                  disabled={!controllable}
                  onClick={() => bumpActive(1)}
                >
                  +
                </button>
                <span className="hint" style={{ margin: 0 }}>
                  fine-steps the active cap
                </span>
              </div>

              {/* Software presets: recall stored caps in MANUAL mode (not the forbidden ATUNE).
                  Only configured slots are shown; the save control below creates/overwrites one. */}
              <div className="field-label" style={{ marginTop: "12px", fontWeight: 700 }}>
                Presets
              </div>
              {presetEntries.length > 0 ? (
                <div className="preset-bank">
                  {presetEntries.map(([n, slot]) => (
                    <div key={n} className="preset-chip">
                      <button
                        className="preset-recall"
                        disabled={!controllable}
                        title="Recall these cap positions (manual mode)"
                        onClick={() => recallPreset(n)}
                      >
                        <span className="preset-n">{n}</span>
                        <span className="preset-vals">
                          T {slot.tune_cap_percent.toFixed(1)} · L {slot.load_cap_percent.toFixed(1)}
                        </span>
                      </button>
                      <button
                        className="preset-clear"
                        disabled={!controllable}
                        title="Clear this preset"
                        onClick={() => clearPreset(n)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="hint" style={{ marginTop: "4px" }}>
                  No presets saved yet — save the current cap positions below.
                </div>
              )}
              <div className="preset-save">
                <span className="hint" style={{ margin: 0 }}>
                  Save current caps →
                </span>
                <select
                  value={saveSlot}
                  disabled={!controllable}
                  onChange={(e) => setSaveSlot(e.target.value)}
                >
                  {Array.from({ length: presets?.num_slots ?? 9 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      slot {n}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!controllable} onClick={() => savePreset(Number(saveSlot))}>
                  Save
                </button>
              </div>
            </section>
  );
}
