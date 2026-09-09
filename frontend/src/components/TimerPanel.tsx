import type { TimerStatus } from "../lib/telemetry.ts";

interface TimerPanelProps {
  controllable: boolean;
  timer: TimerStatus | undefined;
  timerMin: string;
  setTimerMin: (v: string) => void;
  startTimer: () => void;
  stopTimer: () => void;
}

export function TimerPanel(props: TimerPanelProps) {
  const { controllable, timer, timerMin, setTimerMin, startTimer, stopTimer } = props;
  return (
            <section className="panel">
              <h2>Auto-shutoff timer</h2>
              <div className="ramp-actions">
                <label className="ramp-field" style={{ flex: "0 0 82px" }}>
                  <span>Minutes</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={timerMin}
                    disabled={timer?.running}
                    onChange={(e) => setTimerMin(e.target.value)}
                  />
                </label>
                {timer?.running ? (
                  <button className="btn" onClick={stopTimer}>
                    Cancel
                  </button>
                ) : (
                  <button className="btn" onClick={startTimer} disabled={!controllable}>
                    Start timer
                  </button>
                )}
                {timer?.running ? (
                  <span className="hint mono">
                    {Math.ceil(timer.remaining_s / 60)} min left → RF off
                  </span>
                ) : timer?.done ? (
                  <span className="hint mono">timer elapsed · RF commanded off</span>
                ) : (
                  <span className="hint">Commands RF off after N minutes (1–99). Never enables RF.</span>
                )}
              </div>
            </section>
  );
}
