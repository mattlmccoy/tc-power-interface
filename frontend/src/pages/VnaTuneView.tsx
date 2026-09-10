// Full-screen VNA tune view — shown in place of the tabbed dashboard while a VNA session is active
// (RF is locked on the backend). Stripped to the one job: a large Smith chart, the live readout at
// 13.56 MHz, manual tune/load cap controls, and Auto-tune / Sweep / Save / End. Cap-drive and cap
// state come from useOperator; the connection + sweep + auto-tune loop come from useVna.

import type { Operator } from "../hooks/useOperator.ts";
import type { VnaController } from "../hooks/useVna.ts";
import { VnaSmith } from "../components/VnaSmith.tsx";
import { VnaS11Plot } from "../components/VnaS11Plot.tsx";
import { magnitude, vswr, impedance, db } from "../lib/vna/rf.ts";
import { interpS11At, dipOf, F0 } from "../lib/vna/autotune_shape.ts";

const fmt = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

export function VnaTuneView({ op, vna }: { op: Operator; vna: VnaController }) {
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
        </div>
      </div>
    </div>
  );
}
