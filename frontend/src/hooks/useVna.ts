// useVna — owns the NanoVNA connection, the VNA session (begin / 2 s heartbeat / end), the narrow
// sweep, and the informed-sequential auto-tune run loop. It lives at the App level so the connection
// SURVIVES the switch between the dashboard entry card and the full VNA tune view (a component that
// unmounts would drop the port and the loop). Reads status / controllable and the backlash-comp
// cap-drive callbacks from useOperator. The RF interlock itself is enforced on the backend: while a
// VNA session is active, enable_rf is refused (409) — see control/controller.py.

import { useEffect, useRef, useState } from "react";
import type { Status } from "../lib/telemetry.ts";
import { api } from "../lib/api.ts";
import { approachFromBelow, clampCap, capSettled } from "../lib/instrument.ts";
import { NanoVNAConnection } from "../lib/vna/nanovna.ts";
import { magnitude, type SweepPoint } from "../lib/vna/rf.ts";
import { planVnaStep, gammaAt, F0, DEFAULT_MODEL, type TuneModel } from "../lib/vna/autotune.ts";
import { formatTouchstone } from "../lib/vna/touchstone.ts";

const SPAN = 1e6; // narrow sweep: 13.56 MHz ± 1 MHz
const POINTS = 101;
const HEARTBEAT_MS = 2000;

export interface VnaDeps {
  status: Status | null;
  controllable: boolean;
  sendTune: (v: number) => Promise<void>;
  sendLoad: (v: number) => Promise<void>;
}

export interface VnaController {
  supported: boolean;
  connected: boolean;
  sweep: SweepPoint[];
  running: boolean;
  msg: string;
  iter: number;
  connect: () => Promise<void>;
  endSession: () => Promise<void>;
  doSweep: () => Promise<SweepPoint[] | null>;
  runAutoTune: () => Promise<void>;
  stop: () => void;
  saveTouchstone: () => void;
}

export function useVna({ status, controllable, sendTune, sendLoad }: VnaDeps): VnaController {
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
  // On App teardown only: stop the loop + heartbeat. Never end the session here — that is an explicit
  // operator action; a lost heartbeat surfaces as vna_session.stale but keeps RF refused (fail safe).
  useEffect(() => () => {
    runningRef.current = false;
    if (hbRef.current) clearInterval(hbRef.current);
  }, []);

  const supported = NanoVNAConnection.supported();

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

  // Poll the live cap readback until it reaches `target`, waiting out the slow AIT motor between the
  // two steps of a backlash-comp approach-from-below.
  function waitCapSettle(which: "tune" | "load", target: number, tol = 2, timeoutMs = 12000): Promise<void> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const tele = statusRef.current?.controller?.telemetry;
        const read = which === "tune" ? tele?.tune_cap_percent ?? null : tele?.load_cap_percent ?? null;
        if (capSettled(read, target, tol) || Date.now() - t0 >= timeoutMs) { resolve(); return; }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  async function driveCap(which: "tune" | "load", target: number) {
    const send = which === "tune" ? sendTune : sendLoad;
    const [pre, tgt] = approachFromBelow(clampCap(target));
    await send(pre);
    await waitCapSettle(which, pre);
    await send(tgt);
    await waitCapSettle(which, tgt);
  }

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
        const blockedNow = halted();
        if (blockedNow) { setMsg(`stopped: ${blockedNow}`); break; }
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

  function saveTouchstone() {
    if (!sweep.length) return;
    const blob = new Blob([formatTouchstone(sweep)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vna-sweep-${Date.now()}.s1p`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return { supported, connected, sweep, running, msg, iter, connect, endSession, doSweep, runAutoTune, stop, saveTouchstone };
}
