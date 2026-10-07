import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api, detail } from "../lib/api.ts";
import { middleTruncate, savedPath } from "../lib/recordingView.ts";
import type { RunItem } from "../lib/recordingView.ts";
import { recordingDownloads } from "../lib/scopeView.ts";
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
  const active = !!recording?.active;
  const [files, setFiles] = useState<string[] | null>(null);
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  // Re-query when the last run changes or a recording stops (its scope.csv appears at finalize).
  useEffect(() => {
    let live = true;
    if (!lastRun || active) {
      setFiles(null);
    } else {
      api.recordingFiles(lastRun).then((f) => live && setFiles(f));
    }
    api.listRecordings().then((r) => live && setRuns(r));
    return () => { live = false; };
  }, [lastRun, active]);
  const dl = recordingDownloads(files);
  const saved = savedPath(recording, lastRun, runs);
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      flash("path copied", "ok");
    } catch {
      window.prompt("Copy the run folder path:", path); // clipboard blocked (non-secure context)
    }
  };
  const reveal = async (run: string) => {
    try {
      const r = await api.revealRecording(run);
      if (!r.ok) flash("show in Finder failed: " + (await detail(r)), "err");
    } catch (e) {
      flash("show in Finder failed: " + (e as Error).message, "err");
    }
  };
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
              {lastRun && dl.scope ? (
                <button
                  className="btn full"
                  style={{ marginTop: "8px" }}
                  onClick={() =>
                    api
                      .downloadRecordingFile(lastRun, "scope.csv")
                      .catch((e) => flash("download failed: " + (e as Error).message))
                  }
                >
                  ⬇ Download sense loop ({lastRun}) scope.csv
                </button>
              ) : null}
              {saved ? (
                <div className="rec-path">
                  <span className="rec-path-label">{saved.label}</span>
                  <span className="rec-path-text mono" title={saved.path}>
                    {middleTruncate(saved.path, 44)}
                  </span>
                  <div className="rec-path-actions">
                    <button className="btn" onClick={() => copyPath(saved.path)}>Copy path</button>
                    {saved.run ? (
                      <button className="btn" onClick={() => reveal(saved.run as string)}>
                        Show in Finder
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="hint">
                Logs forward / reflected / load power + the thermal-loop commanded curve (phase,
                control temp, commanded W) to telemetry.csv, plus the sense-loop scope_* columns
                (Vrms, B, f0, level) when the scope is connected.
              </div>
            </section>
  );
}
