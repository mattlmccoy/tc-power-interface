// Full-screen VNA tune view — shown in place of the tabbed dashboard while a VNA session is active
// (RF is locked on the backend). Stripped to the one job: a large Smith chart, the live readout at
// 13.56 MHz, manual tune/load cap controls, and Auto-tune / Sweep / Save / End. Cap-drive and cap
// state come from useOperator; the connection + sweep + auto-tune loop come from useVna.

import { useState } from "react";
import type { Operator } from "../hooks/useOperator.ts";
import type { CaptureMode, MapCapture } from "../hooks/useMapCapture.ts";
import { DEFAULT_LOAD_SPAN, DEFAULT_TUNE_SPAN, loadOffsets, quickOffsets, quickTuneOffsets, tuneOffsets } from "../lib/matchmap/plan.ts";
import { fitQuality } from "../lib/matchmap/fit.ts";
import type { VnaController } from "../hooks/useVna.ts";
import { VnaSmith } from "../components/VnaSmith.tsx";
import { VnaS11Plot } from "../components/VnaS11Plot.tsx";
import { magnitude, vswr, impedance, db } from "../lib/vna/rf.ts";
import { interpS11At, dipOf, F0 } from "../lib/vna/autotune_shape.ts";

const fmt = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

export function VnaTuneView({ op, vna, mapCapture }: { op: Operator; vna: VnaController; mapCapture: MapCapture }) {
  const [mapLabel, setMapLabel] = useState("");
  const [tuneSpan, setTuneSpan] = useState(DEFAULT_TUNE_SPAN);
  const [loadSpan, setLoadSpan] = useState(DEFAULT_LOAD_SPAN);
  const [mode, setMode] = useState<CaptureMode>("quick");
  const nPts = mode === "quick" // before clamping at 0/100 %
    ? quickTuneOffsets(tuneSpan).length * quickOffsets(loadSpan).length
    : tuneOffsets(tuneSpan).length * loadOffsets(loadSpan).length;
  const {
    controllable, tune, load, bumpTune, bumpLoad, capBusy, connected, armed, armDevice, disarmDevice,
    tuneVIn, setTuneVIn, applyTuneVolts, loadVIn, setLoadVIn, applyLoadVolts, textInputStyle,
  } = op;
  const rfOn = op.status?.controller?.telemetry?.rf_on ?? false;
  const stale = op.status?.vna_session?.stale ?? false;

  // Read the match at EXACTLY 13.56 MHz by interpolating between sweep bins (like the device's marker),
  // not the nearest bin — on this sharp resonance the nearest bin can be 10+ kHz off and read very wrong.
  const s = vna.sweep.length ? interpS11At(vna.sweep, F0) : null;
  const gm = s ? magnitude(s) : null;
  const z = s ? impedance(s, 50) : null;
  const sw = s ? vswr(s) : null;
  const rl = s ? db(s) : null;

  // Guided manual finish: TUNE moves the dip frequency (→ nulls X), LOAD moves R. Tell the operator
  // which way to nudge each cap to reach the exact 13.56 match, and confirm when it's there.
  const dip = vna.sweep.length ? dipOf(vna.sweep) : null;
  const matched = gm != null && gm < 0.1;
  const guide: string | null = (() => {
    if (!z || !dip) return null;
    if (matched) return "✓ matched";
    const bits: string[] = [];
    const dkHz = (dip.freqHz - F0) / 1e3;
    if (Math.abs(dkHz) > 6) bits.push(`dip ${dkHz > 0 ? "high" : "low"} → Tune ${dkHz > 0 ? "+" : "−"}`);
    if (Math.abs(z.re - 50) > 6) bits.push(`R ${z.re > 50 ? "high" : "low"} → Load ${z.re > 50 ? "+" : "−"}`);
    return bits.length ? bits.join("     ") : "almost — nudge Tune to null X";
  })();

  const capDisabled = !controllable || vna.running || capBusy != null;

  const capRow = (
    label: string,
    pct: number,
    bump: (d: number) => void,
    vin: string,
    setVin: (s: string) => void,
    applyV: () => void,
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ width: 46 }}>{label}</span>
      <button className="btn" onClick={() => bump(-1)} disabled={capDisabled}>−</button>
      <strong style={{ width: 48, textAlign: "center" }}>{Number.isFinite(pct) ? `${pct.toFixed(0)}%` : "—"}</strong>
      <button className="btn" onClick={() => bump(1)} disabled={capDisabled}>+</button>
      <input
        style={{ ...textInputStyle, width: 70 }}
        placeholder="V"
        value={vin}
        onChange={(e) => setVin(e.target.value)}
        disabled={capDisabled}
      />
      <button className="btn" onClick={applyV} disabled={capDisabled || vin.trim() === ""}>Set</button>
    </div>
  );

  return (
    <div className="vna-tune" style={{ padding: "12px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>VNA tune</h2>
        <span className={`badge ${stale ? "warn" : "fault"}`} style={{ fontWeight: 500 }}>
          RF disabled — VNA mode{stale ? " · liveness lost" : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8, fontSize: 13 }}>
        {!connected ? (
          <span style={{ color: "var(--warn)" }}>⚠ Generator not connected — add it from the connect pill (top-right) to drive the AIT.</span>
        ) : armed ? (
          <>
            <span style={{ color: "var(--live)" }}>● ARMED for caps · RF interlocked</span>
            <button className="btn" onClick={() => void disarmDevice()}>Disarm</button>
          </>
        ) : (
          <>
            <span style={{ color: "var(--warn)" }}>Generator connected — not armed</span>
            <button className="btn accent" onClick={() => void armDevice()}>Arm (drive AIT)</button>
          </>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <VnaS11Plot sweep={vna.sweep} height={170} />
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginTop: 16 }}>
        <VnaSmith sweep={vna.sweep} size={320} />

        <div style={{ flex: 1, minWidth: 300, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="readout" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 20px", fontSize: 15 }}>
            <div>|Γ| @ 13.56: <strong>{fmt(gm, 3)}</strong></div>
            <div>VSWR: <strong>{sw != null && Number.isFinite(sw) ? fmt(sw, 2) : "∞"}</strong></div>
            <div>Z: <strong>{fmt(z?.re ?? null, 1)}</strong> {z && z.im >= 0 ? "+" : "−"} j<strong>{fmt(z ? Math.abs(z.im) : null, 1)}</strong> Ω</div>
            <div>RL: <strong>{fmt(rl, 1)}</strong> dB</div>
            <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>sweep: <strong>{vna.readMs ? `${vna.readMs} ms` : "—"}</strong>{vna.readMs ? ` · ${(1000 / vna.readMs).toFixed(1)}/s` : ""}</span>
              <span title="Stale = the NanoVNA returned its previous sweep again (not a new measurement). The read path switches to the reliable two-command read and slows down until reads are fresh.">
                · read {vna.readPath} · stale {vna.stalePct}%
                {vna.lastStale && <strong style={{ color: "var(--warn)" }}> · STALE — waiting for a fresh sweep</strong>}
              </span>
              {vna.bwOptions.length > 0 && (
                <span>
                  · IF bw{" "}
                  <select
                    value={vna.bandwidth ?? ""}
                    onChange={(e) => vna.changeBandwidth(Number(e.target.value))}
                    style={{ ...textInputStyle, padding: "1px 4px", fontSize: 12 }}
                  >
                    {vna.bwOptions.map((hz) => (
                      <option key={hz} value={hz}>{hz} Hz</option>
                    ))}
                  </select>{" "}
                  <span style={{ opacity: 0.7 }}>(higher = faster, noisier)</span>
                </span>
              )}
            </div>
          </div>

          {guide && (
            <div style={{ fontSize: 15, fontWeight: 600, color: matched ? "var(--live)" : "var(--accent)" }}
              title="Tune moves the resonance dip (nulls reactance X); Load sets the resistance R. Nudge as shown to reach the exact 13.56 match.">
              {matched ? guide : `finish → ${guide}`}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {capRow("Tune", tune, bumpTune, tuneVIn, setTuneVIn, applyTuneVolts)}
            {capRow("Load", load, bumpLoad, loadVIn, setLoadVIn, applyLoadVolts)}
            {!controllable && (
              <div className="help-text">Arm the generator (RF off) to drive the caps.</div>
            )}
          </div>

          <div className="controls" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!vna.running ? (
              <button className="btn accent" onClick={() => void vna.runAutoTune()} disabled={!controllable || rfOn}
                title={!controllable ? "arm the generator (RF off) first" : rfOn ? "RF must be off" : ""}>
                Auto-tune
              </button>
            ) : (
              <button className="btn" onClick={vna.stop}>Stop</button>
            )}
            <button className="btn" onClick={vna.saveTouchstone} disabled={!vna.sweep.length}>Save .s1p</button>
            <button className="btn" onClick={vna.saveLog} disabled={!vna.logCount} title="Download the session log (JSON) — every sweep + cap position, for assessing the tuner vs manual">
              Save log ({vna.logCount})
            </button>
            {vna.logCount > 0 && <button className="btn" onClick={vna.clearLog}>Clear log</button>}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => void vna.endSession()}>End VNA session</button>
          </div>

          {(vna.msg || vna.running) && (
            <div className="help-text">{vna.msg}{vna.running ? ` · step ${vna.iter}` : ""}</div>
          )}

          {/* Cold match map for the in-run aid: step the caps around this match and record how each
              move shifts it at exactly 13.56 MHz. Same exclusive-link rules as auto-tune. */}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <strong>Match map</strong>
            <div className="help-text" style={{ margin: 0 }}>
              Once matched, capture a map: the caps step through a grid of ± the spans below around this point
              (Quick: Tune at ±1 %, half-span and span, Load at 5 levels; Full: 1 % Tune steps near the match, 2 % further out; each approached from
              below), the VNA reads 2 fresh sweeps per point (a 3rd if they disagree), then the caps return here.
              Once per network/part; later sessions just Anchor.
              The in-run Match map panel uses it to show where the match has drifted.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input style={{ ...textInputStyle, width: 200 }} placeholder="network label, e.g. 218-2core_v2"
                value={mapLabel} onChange={(e) => setMapLabel(e.target.value)} disabled={mapCapture.busy} />
              <label style={{ fontSize: 13 }}>Tune ±
                <input type="number" min={1} max={20} step={1} value={tuneSpan} disabled={mapCapture.busy}
                  onChange={(e) => setTuneSpan(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))}
                  style={{ ...textInputStyle, width: 52, marginLeft: 4 }} /> %</label>
              <label style={{ fontSize: 13 }}>Load ±
                <input type="number" min={2} max={30} step={2} value={loadSpan} disabled={mapCapture.busy}
                  onChange={(e) => setLoadSpan(Math.max(2, Math.min(30, Math.round(Number(e.target.value) || 2))))}
                  style={{ ...textInputStyle, width: 52, marginLeft: 4 }} /> %</label>
              <select value={mode} disabled={mapCapture.busy} onChange={(e) => setMode(e.target.value as CaptureMode)}
                style={{ ...textInputStyle, padding: "2px 4px" }}
                title="Quick: 5 levels per cap (ends, halves, centre). Full: 1 % Tune steps near the match. The held-out error shown after capture says whether Quick was enough.">
                <option value="quick">Quick</option>
                <option value="full">Full</option>
              </select>
              <span className="aid-note" style={{ margin: 0 }}>{nPts} points · ~{Math.max(1, Math.round((nPts * 3) / 60))} min</span>
              {!mapCapture.busy ? (
                <button className="btn accent" onClick={() => void mapCapture.start(mapLabel, tuneSpan, loadSpan, mode)}
                  disabled={!controllable || rfOn || vna.running || !vna.connected}
                  title={!controllable ? "arm the generator (RF off) first" : rfOn ? "RF must be off" : ""}>
                  Capture map
                </button>
              ) : (
                <button className="btn" onClick={vna.stop}>Stop capture</button>
              )}
              {mapCapture.result && (
                <button className="btn" onClick={mapCapture.download}>Save map JSON</button>
              )}
              <button className="btn" onClick={() => void mapCapture.anchorHere()}
                disabled={mapCapture.busy || vna.running || !vna.connected}
                title="Once you have the match (by hand or auto), re-anchor the active map here from one VNA reading — no recapture needed while the network build is unchanged. Moves no cap.">
                Anchor map here
              </button>
            </div>
            {mapCapture.progress && (
              <div className="aid-note" style={{ margin: 0 }}>
                point {Math.min(mapCapture.progress.done + 1, mapCapture.progress.total)} / {mapCapture.progress.total} · {mapCapture.progress.label}
              </div>
            )}
            {mapCapture.result && (
              <div className="readout" style={{ fontSize: 13, padding: 8 }}>
                {fitQuality(mapCapture.result.fit).rough && (
                  <div style={{ color: "var(--warn)", fontWeight: 600 }}>{fitQuality(mapCapture.result.fit).text}</div>
                )}
                {mapCapture.result.points.length} points · {mapCapture.result.fit.kind} fit · RMS {mapCapture.result.fit.rmsOhm.toFixed(1)} Ω ·
                held-out {mapCapture.result.fit.looRmsOhm?.toFixed(1) ?? "—"} Ω ·
                cold match T {mapCapture.result.coldMatch.tune.toFixed(1)} % / L {mapCapture.result.coldMatch.load.toFixed(1)} %
                (|Γ| {mapCapture.result.coldMatch.gamma.toFixed(3)})
                {mapCapture.driftOhm != null && <> · drift during capture {mapCapture.driftOhm.toFixed(1)} Ω</>}
              </div>
            )}
            {mapCapture.msg && <div className="aid-note" style={{ margin: 0 }}>{mapCapture.msg}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
