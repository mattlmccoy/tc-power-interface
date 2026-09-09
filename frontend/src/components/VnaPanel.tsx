// Pre-run VNA auto-tune panel. Connects a NanoVNA over Web Serial (Chrome/Edge), reads live S11 at
// 13.56 MHz, and — with RF OFF — drives the tune/load caps to the Smith centre using the pure control
// law in lib/vna/autotune.ts. Connecting AUTO-BEGINS a VNA session on the operator: while it is active
// the backend refuses enable_rf (409). The session ends only on an explicit End (fail safe: switching
// away or a dead tab surfaces as vna_session.stale but never re-allows RF). This is distinct from the
// in-run reflected-power tuner (control/match_tuner.py), which is untouched.

import { useEffect, useRef, useState } from "react";
import type { Status } from "../lib/telemetry.ts";
import { api } from "../lib/api.ts";
import { approachFromBelow, clampCap } from "../lib/instrument.ts";
import { NanoVNAConnection } from "../lib/vna/nanovna.ts";
import { magnitude, vswr, impedance, db, type SweepPoint } from "../lib/vna/rf.ts";
import { planVnaStep, gammaAt, F0, DEFAULT_MODEL, type TuneModel } from "../lib/vna/autotune.ts";

const SPAN = 1e6; // narrow sweep: 13.56 MHz ± 1 MHz
const POINTS = 101;
const HEARTBEAT_MS = 2000;

interface Props {
  status: Status | null;
  /** connected && armed — from App; caps can only be driven when true. */
  controllable: boolean;
  sendTune: (v: number) => Promise<void>;
  sendLoad: (v: number) => Promise<void>;
  waitCapSettle: (which: "tune" | "load", target: number, tol?: number, timeoutMs?: number) => Promise<void>;
}

export default function VnaPanel({ status, controllable, sendTune, sendLoad, waitCapSettle }: Props) {
  const connRef = useRef<NanoVNAConnection | null>(null);
  const hbRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const statusRef = useRef(status);
  const controllableRef = useRef(controllable);

  const [connected, setConnected] = useState(false);
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [iter, setIter] = useState(0);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { controllableRef.current = controllable; }, [controllable]);
  // Cleanup on unmount: stop the loop and the heartbeat, but DO NOT end the session — leaving the
  // Experimental tab must not silently re-allow RF. The backend surfaces the lost heartbeat as stale.
  useEffect(() => () => {
    runningRef.current = false;
    if (hbRef.current) clearInterval(hbRef.current);
  }, []);

  const supported = NanoVNAConnection.supported();
  const tel = status?.controller?.telemetry;
  const rfOn = tel?.rf_on ?? false;
  const sessionActive = status?.vna_session?.active ?? connected;
  const sessionStale = status?.vna_session?.stale ?? false;

  function startHeartbeat() {
    if (hbRef.current) clearInterval(hbRef.current);
    hbRef.current = setInterval(() => { void api.vnaHeartbeat(); }, HEARTBEAT_MS);
  }

  async function doSweep(): Promise<SweepPoint[] | null> {
    const conn = connRef.current;
    if (!conn) return null;
    const res = await conn.sweep(F0 - SPAN, F0 + SPAN, POINTS);
    setSweep(res.points);
    return res.points;
  }

  async function connect() {
    if (!supported) return;
    const conn = new NanoVNAConnection();
    try {
      await conn.connect();
      connRef.current = conn;
      setConnected(true);
      setMsg("");
      await api.vnaBegin(); // fail-safe: a VNA connected in the tool ⇒ RF locked
      startHeartbeat();
      await doSweep();
    } catch (e) {
      setMsg(`connect failed: ${(e as Error).message}`);
      try { await conn.disconnect(); } catch { /* ignore */ }
      connRef.current = null;
    }
  }

  async function endSession() {
    runningRef.current = false;
    setRunning(false);
    if (hbRef.current) { clearInterval(hbRef.current); hbRef.current = null; }
    try { await api.vnaEnd(); } catch { /* ignore */ }
    try { await connRef.current?.disconnect(); } catch { /* ignore */ }
    connRef.current = null;
    setConnected(false);
    setSweep([]);
    setMsg("");
  }

  // Drive one cap to `target` from below (backlash-compensated two-step), reusing App's settle wait.
  async function driveCap(which: "tune" | "load", target: number) {
    const send = which === "tune" ? sendTune : sendLoad;
    const [pre, tgt] = approachFromBelow(clampCap(target));
    await send(pre);
    await waitCapSettle(which, pre);
    await send(tgt);
    await waitCapSettle(which, tgt);
  }

  // Why the loop is blocked from driving caps, or null when it may run.
  function halted(): string | null {
    if (!controllableRef.current) return "device not armed";
    if (statusRef.current?.controller?.telemetry?.rf_on) return "RF is on";
    return null;
  }

  async function runAutoTune() {
    const blocked = halted();
    if (blocked) { setMsg(`cannot run: ${blocked}`); return; }
    runningRef.current = true;
    setRunning(true);
    setMsg("tuning…");
    const model: TuneModel = { ...DEFAULT_MODEL };
    let prevCost = Infinity;
    let lastAxis: "tune" | "load" | null = null;
    let i = 0;
    try {
      while (runningRef.current && i < model.maxIter) {
        const stop = halted();
        if (stop) { setMsg(`stopped: ${stop}`); break; }
        const points = await doSweep();
        if (!points || !points.length) { setMsg("stopped: no sweep"); break; }
        const here = gammaAt(points);
        const cost = here ? magnitude(here.s11) : 1;
        // self-correct: if the previous move raised cost, flip that axis's assumed sign
        if (lastAxis && cost > prevCost + 1e-3) {
          if (lastAxis === "tune") model.tuneSign = (-model.tuneSign) as 1 | -1;
          else model.loadSign = (-model.loadSign) as 1 | -1;
        }
        const t = statusRef.current?.controller?.telemetry;
        const caps = { tune: clampCap(t?.tune_cap_percent ?? 50), load: clampCap(t?.load_cap_percent ?? 50) };
        const step = planVnaStep(points, caps, model);
        setIter(++i);
        if (step.converged) { setMsg(`matched · |Γ|=${step.cost.toFixed(3)}`); break; }
        if (step.abort) { setMsg(`aborted: ${step.abort}`); break; }
        prevCost = cost;
        if (step.action === "tune") { await driveCap("tune", step.nextTune); lastAxis = "tune"; }
        else if (step.action === "load") { await driveCap("load", step.nextLoad); lastAxis = "load"; }
        else break;
      }
      if (runningRef.current && i >= model.maxIter) setMsg("stopped: max iterations");
    } catch (e) {
      setMsg(`run error: ${(e as Error).message}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  function stop() { runningRef.current = false; setRunning(false); }

  // --- readout at 13.56 MHz ---
  const p = sweep.length ? gammaAt(sweep) : null;
  const gm = p ? magnitude(p.s11) : null;
  const z = p ? impedance(p.s11, 50) : null;
  const sw = p ? vswr(p.s11) : null;
  const rl = p ? db(p.s11) : null;
  const fmt = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

  // Smith dot: Γ plane, unit circle radius R about centre.
  const R = 64, CX = 76, CY = 76;
  const gx = p ? CX + Math.max(-1, Math.min(1, p.s11.re)) * R : CX;
  const gy = p ? CY - Math.max(-1, Math.min(1, p.s11.im)) * R : CY;

  return (
    <section className="panel vna-panel">
      <h2>VNA auto-tune (pre-run)</h2>
      <div className="banner experimental help-text">
        <strong>Experimental — RF-off coarse match.</strong> Connect a NanoVNA over Web Serial and drive
        the caps to 50 Ω at 13.56 MHz before a fire. Connecting locks RF (VNA mode); End to unlock.
        Requires the generator armed with RF off. Distinct from the in-run reflected-power tuner.
      </div>

      {!supported && (
        <div className="banner warn">Web Serial is unavailable — use desktop Chrome or Edge.</div>
      )}

      {sessionActive && (
        <div className={`banner ${sessionStale ? "warn" : "fault"}`} style={{ margin: "8px 0" }}>
          <strong>VNA mode — RF disabled.</strong>{sessionStale ? " Liveness lost — reconnect or End." : ""}
        </div>
      )}

      <div className="row" style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <svg width={2 * CX} height={2 * CY} viewBox={`0 0 ${2 * CX} ${2 * CY}`} role="img" aria-label="Smith position">
          <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--border-strong, #999)" strokeWidth="1" />
          <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="var(--border, #ccc)" strokeWidth="0.5" />
          <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="var(--border, #ccc)" strokeWidth="0.5" />
          <circle cx={CX} cy={CY} r="3" fill="var(--live, #2b8a3e)" />
          {p && <circle cx={gx} cy={gy} r="5" fill="var(--err-btn, #c92a2a)" />}
        </svg>

        <div className="readout" style={{ minWidth: 180 }}>
          <div>|Γ| @ 13.56: <strong>{fmt(gm, 3)}</strong></div>
          <div>Z: <strong>{fmt(z?.re ?? null, 1)}</strong> {z && z.im >= 0 ? "+" : "−"} j<strong>{fmt(z ? Math.abs(z.im) : null, 1)}</strong> Ω</div>
          <div>VSWR: <strong>{sw != null && Number.isFinite(sw) ? fmt(sw, 2) : "∞"}</strong></div>
          <div>RL: <strong>{fmt(rl, 1)}</strong> dB</div>
        </div>
      </div>

      <div className="controls" style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {!connected ? (
          <button className="btn accent" onClick={() => void connect()} disabled={!supported}>Connect NanoVNA</button>
        ) : (
          <>
            <button className="btn" onClick={() => void doSweep()} disabled={running}>Sweep</button>
            {!running ? (
              <button className="btn accent" onClick={() => void runAutoTune()} disabled={!controllable || rfOn}
                title={!controllable ? "arm the generator (RF off) first" : rfOn ? "RF must be off" : ""}>
                Auto-tune
              </button>
            ) : (
              <button className="btn" onClick={stop}>Stop</button>
            )}
          </>
        )}
        {(connected || sessionActive) && (
          <button className="btn" onClick={() => void endSession()}>End VNA session</button>
        )}
      </div>

      {(msg || running) && (
        <div className="help-text" style={{ marginTop: 6 }}>{msg}{running ? ` · step ${iter}` : ""}</div>
      )}
    </section>
  );
}
