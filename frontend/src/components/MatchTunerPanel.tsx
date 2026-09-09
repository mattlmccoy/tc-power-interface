import type { MatchTunerStatus, Telemetry } from "../lib/telemetry.ts";

interface MatchTunerPanelProps {
  controllable: boolean;
  t: Telemetry | null;
  mt: MatchTunerStatus | undefined;
  setMatchMode: (m: string) => void;
  startMatchTuner: () => void;
  stopMatchTuner: () => void;
  armMatchTuner: () => void;
  disarmMatchTuner: () => void;
  revPct: (f: number | null | undefined) => string;
  fmtDelta: (d: number) => string;
}

export function MatchTunerPanel(props: MatchTunerPanelProps) {
  const {
    controllable, t, mt, setMatchMode, startMatchTuner, stopMatchTuner, armMatchTuner,
    disarmMatchTuner, revPct, fmtDelta,
  } = props;
  return (
            <section className="panel">
              <h2>Match tuner</h2>
              <div className="banner experimental help-text">
                <strong>Experimental — untested on hardware.</strong> Perturb-and-observe on reverse
                power: it trims the tune/load caps toward the local minimum as the load drifts. It
                never enables RF and only drives caps in <em>auto</em> while armed and RF is on.
              </div>
              <div className="ramp-actions">
                <label className="ramp-field" style={{ flex: "0 0 150px" }}>
                  <span>Mode</span>
                  <select
                    value={mt?.mode ?? "advisory"}
                    disabled={!controllable}
                    onChange={(e) => setMatchMode(e.target.value)}
                  >
                    <option value="advisory">advisory (watch only)</option>
                    <option value="auto">auto (drives caps)</option>
                  </select>
                </label>
                {mt?.running ? (
                  <button className="btn" onClick={stopMatchTuner}>
                    Stop
                  </button>
                ) : (
                  <button className="btn accent" onClick={startMatchTuner} disabled={!controllable}>
                    Start
                  </button>
                )}
                {mt?.armed ? (
                  <button className="btn" onClick={disarmMatchTuner}>
                    Disarm
                  </button>
                ) : (
                  <button
                    className="btn danger"
                    onClick={armMatchTuner}
                    disabled={!controllable || !t?.rf_on || !mt?.running}
                    title={
                      !mt?.running
                        ? "Start the tuner first"
                        : !t?.rf_on
                          ? "Enable RF first — the tuner only drives caps while RF is on"
                          : "Arm: allow the tuner to drive the caps (auto mode)"
                    }
                  >
                    Arm
                  </button>
                )}
              </div>
              <div className="mt-readout mono">
                {mt?.running ? (
                  <>
                    <span className={`mt-phase ${mt.phase}`}>{mt.phase}</span> · reverse{" "}
                    {revPct(mt.reverse_fraction)} · best {revPct(mt.best)}
                    {mt.last_move
                      ? ` · last ${mt.last_move.axis} ${fmtDelta(mt.last_move.delta)}`
                      : ""}
                  </>
                ) : (
                  <span className="hint" style={{ margin: 0 }}>
                    Stopped. Start, then Arm in auto to trim caps toward minimum reverse (RF on).
                  </span>
                )}
              </div>
              {mt?.mode === "advisory" && mt?.recommended ? (
                <div className="hint">
                  Recommended (advisory — not applied): tune {mt.recommended.tune.toFixed(1)}% · load{" "}
                  {mt.recommended.load.toFixed(1)}%
                </div>
              ) : null}
              {mt?.running && !t?.rf_on ? (
                <div className="hint">Arming is disabled until RF is on.</div>
              ) : null}
            </section>
  );
}
