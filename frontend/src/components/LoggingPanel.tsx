import { api } from "../lib/api.ts";

interface LoggingPanelProps {
  autoLog: boolean;
  setAutoLog: (v: boolean) => void;
}

export function LoggingPanel({ autoLog, setAutoLog }: LoggingPanelProps) {
  return (
            <section className="panel">
              <h2>Logging</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoLog}
                  onChange={(e) => {
                    setAutoLog(e.target.checked);
                    api.setAutoLog(e.target.checked);
                  }}
                />
                Auto-log power curves on RF-on
              </label>
              <div className="hint">
                Starts a telemetry recording automatically when RF turns on (device power + the
                thermal-loop commanded curve). Keeps recording through cooldown — stop it manually.
                Download the CSV from the Recording panel.
              </div>
            </section>
  );
}
