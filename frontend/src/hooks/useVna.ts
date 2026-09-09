// useVna — owns the NanoVNA connection, the VNA session (begin / 2 s heartbeat / end), a CONTINUOUS
// live sweep (so the Smith, S11 plot and readout update live as the caps turn), the SHAPE-BASED
// auto-tune loop, and a session log (every sweep, auto + manual, saveable as JSON so the algo can be
// assessed against a manual tune). Lives at App level so the connection survives the dashboard→tune
// switch. The RF interlock is enforced on the backend (enable_rf → 409 while a session is active).

import { useEffect, useRef, useState } from "react";
import type { Status } from "../lib/telemetry.ts";
import { api } from "../lib/api.ts";
import { approachFromBelow, clampCap, capSettled } from "../lib/instrument.ts";
import { NanoVNAConnection } from "../lib/vna/nanovna.ts";
import { impedance, magnitude, nearestPointByFrequency, type SweepPoint } from "../lib/vna/rf.ts";
import { F0 } from "../lib/vna/autotune.ts";
import { shapeTune, dipOf } from "../lib/vna/autotune_shape.ts";
import { formatTouchstone } from "../lib/vna/touchstone.ts";

// Tight window around 13.56 MHz. The real match loop is only ~140 kHz wide, so a 12–18 MHz sweep put
// only ~5 points on it (the "boxy" loop that could not be resolved). 1 MHz / 201 pts = 5 kHz/point puts
// ~28 points on the loop while still covering a ~3.5% tune detune (the dip shifts ~0.4 MHz per 3%).
const SWEEP_START = 13.06e6;
const SWEEP_STOP = 14.06e6;
const POINTS = 201;
const HEARTBEAT_MS = 2000;
const LIVE_GAP_MS = 30;
const LOG_CAP = 6000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LogEntry {
  t: number;
  phase: "live" | "auto";
  tune: number | null;
  load: number | null;
  dipHz: number | null;
  gammaMin: number | null;
  g1356: number | null;
  R: number | null;
  X: number | null;
  sweep?: Array<{ f: number; re: number; im: number }>;
}

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
  logCount: number;
  connect: () => Promise<void>;
  endSession: () => Promise<void>;
  doSweep: () => Promise<SweepPoint[] | null>;
  runAutoTune: () => Promise<void>;
  stop: () => void;
  saveTouchstone: () => void;
  saveLog: () => void;
  clearLog: () => void;
}

export function useVna({ status, controllable, sendTune, sendLoad }: VnaDeps): VnaController {
  const connRef = useRef<NanoVNAConnection | null>(null);
  const hbRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const liveRef = useRef(false);
  const statusRef = useRef(status);
  const controllableRef = useRef(controllable);
  const logRef = useRef<LogEntry[]>([]);

  const [connected, setConnected] = useState(false);
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [iter, setIter] = useState(0);
  const [logCount, setLogCount] = useState(0);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { controllableRef.current = controllable; }, [controllable]);
  useEffect(() => () => {
    runningRef.current = false;
    liveRef.current = false;
    if (hbRef.current) clearInterval(hbRef.current);
  }, []);

  const supported = NanoVNAConnection.supported();

  function startHeartbeat() {
    if (hbRef.current) clearInterval(hbRef.current);
    hbRef.current = setInterval(() => { void api.vnaHeartbeat(); }, HEARTBEAT_MS);
  }

  // Append one sweep to the session log with the current caps + shape metrics. Captures manual tuning
  // (the live loop logs each sweep as the caps change) and auto tuning ('auto', with the full sweep).
  function logSweep(phase: "live" | "auto", points: SweepPoint[], full = false) {
    const tel = statusRef.current?.controller?.telemetry;
    const dip = dipOf(points);
    const p = nearestPointByFrequency(points, F0);
    const z = p ? impedance(p.s11, 50) : null;
    const e: LogEntry = {
      t: Date.now(), phase,
      tune: tel?.tune_cap_percent ?? null, load: tel?.load_cap_percent ?? null,
      dipHz: dip?.freqHz ?? null, gammaMin: dip?.gammaMin ?? null,
      g1356: p ? magnitude(p.s11) : null, R: z ? z.re : null, X: z ? z.im : null,
    };
    if (full) e.sweep = points.map((s) => ({ f: s.frequency, re: s.s11.re, im: s.s11.im }));
    logRef.current.push(e);
    if (logRef.current.length > LOG_CAP) logRef.current.shift();
    setLogCount(logRef.current.length);
  }

  async function doSweep(): Promise<SweepPoint[] | null> {
    const conn = connRef.current;
    if (!conn) return null;
    const res = await conn.sweep(SWEEP_START, SWEEP_STOP, POINTS);
    setSweep(res.points);
    return res.points;
  }

  async function liveLoop() {
    while (liveRef.current) {
      if (runningRef.current) { await sleep(100); continue; }
      try {
        const points = await doSweep();
        if (points) logSweep("live", points);
      } catch (e) {
        liveRef.current = false;
        setMsg(`sweep failed: ${(e as Error).message} — reconnect the NanoVNA`);
        break;
      }
      await sleep(LIVE_GAP_MS);
    }
  }

  async function connect() {
    if (!supported) return;
    const conn = new NanoVNAConnection();
    try {
      await conn.connect();
      connRef.current = conn;
      setConnected(true);
      setMsg("");
      await api.vnaBegin();
      startHeartbeat();
      liveRef.current = true;
      void liveLoop();
    } catch (e) {
      setMsg(`connect failed: ${(e as Error).message}`);
      try { await conn.disconnect(); } catch { /* ignore */ }
      connRef.current = null;
    }
  }

  async function endSession() {
    runningRef.current = false;
    liveRef.current = false;
    setRunning(false);
    if (hbRef.current) { clearInterval(hbRef.current); hbRef.current = null; }
    try { await api.vnaEnd(); } catch { /* ignore */ }
    try { await connRef.current?.disconnect(); } catch { /* ignore */ }
    connRef.current = null;
    setConnected(false);
    setSweep([]);
    setMsg("");
  }

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

  // Shape-based auto-tune: pause the live loop, drive the caps by reading the loop shape each sweep.
  async function runAutoTune() {
    const blocked = halted();
    if (blocked) { setMsg(`cannot run: ${blocked}`); return; }
    runningRef.current = true;
    setRunning(true);
    setIter(0);
    setMsg("tuning…");
    const t = statusRef.current?.controller?.telemetry;
    const start = { tune: clampCap(t?.tune_cap_percent ?? 50), load: clampCap(t?.load_cap_percent ?? 50) };
    let curT = start.tune, curL = start.load;

    const probe = async (tune: number, load: number): Promise<SweepPoint[]> => {
      if (tune !== curT) { await driveCap("tune", tune); curT = tune; }
      if (load !== curL) { await driveCap("load", load); curL = load; }
      const points = (await doSweep()) ?? [];
      if (points.length) logSweep("auto", points, true);
      return points;
    };

    try {
      const res = await shapeTune(probe, start, {
        onStep: ({ iter: i, dipHz, cost }) => { setIter(i); setMsg(`tuning · dip ${(dipHz / 1e6).toFixed(3)} MHz · |Γ|=${cost.toFixed(3)}`); },
        shouldStop: () => !runningRef.current || halted() != null,
      });
      setMsg(res.converged ? `matched · caps ${res.tune}% / ${res.load}% (${res.iters} steps)` : `stopped · caps ${res.tune}% / ${res.load}%`);
    } catch (e) {
      setMsg(`run error: ${(e as Error).message}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      if (connRef.current && !liveRef.current) { liveRef.current = true; void liveLoop(); }
    }
  }

  function stop() { runningRef.current = false; setRunning(false); }

  function download(name: string, text: string, type: string) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function saveTouchstone() {
    if (!sweep.length) return;
    download(`vna-sweep-${Date.now()}.s1p`, formatTouchstone(sweep), "text/plain");
  }

  function saveLog() {
    if (!logRef.current.length) return;
    const data = { savedAt: new Date().toISOString(), window: { start: SWEEP_START, stop: SWEEP_STOP, points: POINTS }, entries: logRef.current };
    download(`vna-log-${Date.now()}.json`, JSON.stringify(data), "application/json");
  }

  function clearLog() { logRef.current = []; setLogCount(0); }

  return {
    supported, connected, sweep, running, msg, iter, logCount,
    connect, endSession, doSweep, runAutoTune, stop, saveTouchstone, saveLog, clearLog,
  };
}
