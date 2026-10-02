// In-run match aid (advisory). Shows the cold match map captured in the VNA view, the live T/L
// readback, recent held-position readings, and where the drifted match must be given those readings.
// It has NO cap controls: the operator tunes with the Matching network panel (or by hand).

import type { MatchAid } from "../hooks/useMatchAid.ts";
import type { Telemetry } from "../lib/telemetry.ts";
import { aidMessage } from "../lib/matchmap/message.ts";
import { travelLevel, type DriftSummary } from "../lib/matchmap/drift.ts";
import { MatchMapPlot } from "./MatchMapPlot.tsx";

const ago = (tMs: number, nowMs: number) => `${Math.max(0, Math.round((nowMs - tMs) / 1000))} s ago`;

const rateText = (r: number | null) =>
  r == null ? "no retunes yet" : Math.abs(r) < 0.1 ? "steady" : `${r > 0 ? "↑" : "↓"} ${Math.abs(r).toFixed(1)} %/Wh`;

/** This run's own drift (from the positions the operator found the match at) and cap travel left. */
function DriftBlock({ d, fwd, reset }: { d: DriftSummary; fwd: number; reset: () => void }) {
  const level = travelLevel(d);
  const color = level === "err" ? "var(--err)" : level === "warn" ? "var(--warn)" : "var(--fg)";
  const row = (name: string, rate: number | null, left: number | null, wh: number | null, min: number | null) => (
    <div className="mono" style={{ fontSize: 12 }}>
      {name} {rateText(rate)} · <strong style={{ color }}>{left != null ? `${left.toFixed(1)} % left` : "—"}</strong>
      {wh != null && min != null && <> · reaches 0 % in ~{wh.toFixed(0)} Wh (~{min.toFixed(0)} min at {fwd.toFixed(0)} W)</>}
    </div>
  );
  return (
    <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <strong>Drift &amp; travel</strong>
        <span className="aid-note" style={{ margin: 0 }}>this run: {d.eWh.toFixed(1)} Wh · {d.holds} matched positions</span>
      </div>
      {row("Tune", d.tuneRate, d.tuneLeft, d.whToTuneFloor, d.minToTuneFloor)}
      {row("Load", d.loadRate, d.loadLeft, d.whToLoadFloor, d.minToLoadFloor)}
      <div className="aid-note" style={{ marginTop: 4 }}>
        From where you found the match in THIS run only (≤ 1 % reflected, held ≥ 3 s), per Wh delivered.
        Starts fresh with each new recording, after 5 min with RF off, or on Reset.{" "}
        <button className="btn" style={{ padding: "0 6px", fontSize: 11 }} onClick={reset}>Reset</button>
      </div>
    </div>
  );
}

export function MatchAidPanel({ aid, t }: { aid: MatchAid; t: Telemetry | null }) {
  const { map, result, readings, current } = aid;
  const nowMs = t ? t.host_timestamp_ns / 1e6 : 0;
  const msg = result ? aidMessage(result, aid.guidance, t?.forward_w ?? 0, t?.rf_on ?? false) : null;
  const color = msg?.tone === "warn" ? "var(--warn)" : msg?.tone === "ok" ? "var(--live)" : "var(--accent)";

  const fileInput = (
    <label className="btn" style={{ cursor: "pointer" }} title="Load a match-map JSON saved from the VNA view">
      Load map file…
      <input type="file" accept="application/json,.json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void aid.loadFile(f); e.target.value = ""; }} />
    </label>
  );

  return (
    <section className="panel">
      <h2>Match aid <span className="hint" style={{ fontWeight: 400 }}>— advisory, never moves a cap</span></h2>
      <DriftBlock d={aid.drift} fwd={t?.forward_w ?? 0} reset={aid.resetDrift} />
      {!map ? (
        <>
          <div className="aid-note" style={{ marginTop: 0 }}>
            No map yet. In the VNA view (RF off), after you have the match, press <strong>Capture map</strong>:
            the caps step around the match and the VNA records how each move shifts it.
          </div>
          <div style={{ marginTop: 8 }}>{fileInput}</div>
        </>
      ) : (
        <>
          <div className="hint mono" style={{ marginTop: 0 }}>
            <strong>{map.label}</strong> · {map.createdAt.slice(0, 16).replace("T", " ")} · {map.points.length} points ·
            fit {map.fit.rmsOhm.toFixed(1)} Ω (held-out {map.fit.looRmsOhm?.toFixed(1) ?? "—"} Ω) ·
            cold match T {map.coldMatch.tune.toFixed(1)} % / L {map.coldMatch.load.toFixed(1)} %
          </div>
          {msg && <div style={{ margin: "8px 0", fontWeight: 600, color }}>{msg.text}</div>}
          {result && <MatchMapPlot map={map} result={result} readings={readings} current={current} />}
          <div className="aid-legend">
            <span><span className="aid-swatch" style={{ background: "var(--live)" }} />cold map ≥ 15 dB (before heating)</span>
            <span><span className="aid-swatch" style={{ background: "var(--fg)", opacity: 0.5 }} />where the match can be now</span>
            <span>× cold match · ○ estimate · ● caps now</span>
          </div>
          {readings.length > 0 && (
            <div className="hint mono" style={{ marginTop: 6 }}>
              {readings.slice().reverse().map((r) => (
                <div key={r.tFirst}>T {r.tune.toFixed(1)} · L {r.load.toFixed(1)} · {r.rev.toFixed(1)} W of {r.fwd.toFixed(0)} W · {ago(r.tLast, nowMs)}</div>
              ))}
            </div>
          )}
          <div className="aid-note">
            Readings are positions held ≥ 2 s with RF on, kept for 30 s (the load keeps drifting). The map
            assumes the hot network keeps its cold shape and only shifts. If reflected power is rising
            together with transformer or core temperature, turn RF off — don't retune (2026-09-24).
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {fileInput}
            <button className="btn" onClick={aid.clearReadings} disabled={!readings.length}>Clear readings</button>
          </div>
        </>
      )}
      {aid.err && <div className="aid-note" style={{ color: "var(--err)" }}>{aid.err}</div>}
    </section>
  );
}
