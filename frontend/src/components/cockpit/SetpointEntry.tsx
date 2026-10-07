import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";

export const SP_FINE = 5; // live power nudge: fine step (W) — ↑/↓ and the ±5 buttons
export const SP_COARSE = 25; // live power nudge: coarse step (W) — Shift+↑/↓ and the ±25 buttons

interface SetpointEntryProps {
  controllable: boolean;
  setpointInput: string;
  setSetpointInput: (v: string) => void;
  setpointRef: MutableRefObject<number>;
  applySetpoint: () => void;
  nudgeSetpoint: (d: number) => void;
  onSetpointKey: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** Forward-power ceiling from the limits, or null while unknown. */
  ceilingW: number | null;
}

/** The setpoint number box, Apply, the ±fine/±coarse nudge buttons and the hint line. Shared by the
 *  Dashboard's RF power panel and the cockpit; the markup and class names are the Dashboard's, so the
 *  existing CSS applies unchanged. Renders a fragment: the caller supplies the label and container. */
export function SetpointEntry(props: SetpointEntryProps) {
  const { controllable, setpointInput, setSetpointInput, setpointRef, applySetpoint, nudgeSetpoint, onSetpointKey, ceilingW } = props;
  return (
    <>
                  <div className="setpoint-entry">
                    <input
                      id="sp"
                      className="setpoint-input"
                      type="number"
                      min={0}
                      value={setpointInput}
                      onChange={(e) => {
                        setSetpointInput(e.target.value);
                        const n = Number(e.target.value);
                        if (e.target.value.trim() !== "" && !Number.isNaN(n)) setpointRef.current = n;
                      }}
                      onKeyDown={onSetpointKey}
                    />
                    <span className="setpoint-unit">W</span>
                    <button className="btn accent" onClick={applySetpoint} disabled={!controllable}>
                      Apply
                    </button>
                  </div>
                  {/* Live power nudge — each press sends instantly (no Apply), clamped to the ceiling.
                      Single-click only (no auto-repeat), like the cap steppers. ↑/↓ = ±fine on the
                      field, Shift+↑/↓ = ±coarse. */}
                  <div className="setpoint-nudge">
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(-SP_COARSE)} disabled={!controllable}>
                      −{SP_COARSE}
                    </button>
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(-SP_FINE)} disabled={!controllable}>
                      −{SP_FINE}
                    </button>
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(SP_FINE)} disabled={!controllable}>
                      +{SP_FINE}
                    </button>
                    <button className="btn step-btn" onClick={() => nudgeSetpoint(SP_COARSE)} disabled={!controllable}>
                      +{SP_COARSE}
                    </button>
                  </div>
                  <div className="hint">
                    Live −/+ sends at once (no Apply) · ↑/↓ ±{SP_FINE}, Shift ±{SP_COARSE} W · ceiling{" "}
                    {ceilingW ?? "—"} W (clamped). Edit in Settings.
                  </div>
    </>
  );
}
