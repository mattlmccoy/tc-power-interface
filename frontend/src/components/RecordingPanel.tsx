import type { CSSProperties } from "react";
import { api } from "../lib/api.ts";
import type { Status } from "../lib/telemetry.ts";

interface RecordingPanelProps {
  controllable: boolean;
  recording: Status["recording"] | undefined;
  lastRun: string | null;
  runName: string;
  setRunName: (v: string) => void;
  flash: (msg: string, tone?: "ok" | "err" | "warn") => void;
  textInputStyle: CSSProperties;
}

export function RecordingPanel(props: RecordingPanelProps) {
  const { controllable, recording, lastRun, runName, setRunName, flash, textInputStyle } = props;
  return (
            <section className="panel">
              <h2>Recording</h2>
              {recording?.active ? (
                <>
                  <button className="btn rec full" onClick={() => api.stopRecording()}>
                    ■ Stop recording
                  </button>
                  <div className="hint mono">recording → {recording.run}</div>
                </>
              ) : (
                <>
                  <input
                    className="mono"
                    style={textInputStyle}
                    placeholder="run name"
                    value={runName}
                    onChange={(e) => setRunName(e.target.value)}
                  />
                  <button
                    className="btn full"
                    disabled={!controllable}
                    onClick={() => api.startRecording(runName.trim() || "run", "")}
                  >
                    ● Start recording
                  </button>
                </>
              )}
              {lastRun ? (
                <button
                  className="btn full"
                  style={{ marginTop: "8px" }}
                  onClick={() =>
                    api
                      .downloadRecording(lastRun)
                      .catch((e) => flash("download failed: " + (e as Error).message))
                  }
                >
                  ⬇ Download power curves ({lastRun}) CSV
                </button>
              ) : null}
              <div className="hint">
                Logs forward / reflected / load power + the thermal-loop commanded curve (phase,
                control temp, commanded W) to telemetry.csv.
              </div>
            </section>
  );
}
