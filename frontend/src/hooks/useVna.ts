// useVna — owns the NanoVNA connection, the VNA session (begin / 2 s heartbeat / end), a CONTINUOUS
// live sweep (so the Smith, S11 plot and readout update live as the caps turn), the SHAPE-BASED
// auto-tune loop, and a session log (every sweep, auto + manual, saveable as JSON so the algo can be
// assessed against a manual tune). Lives at App level so the connection survives the dashboard→tune
// switch. The RF interlock is enforced on the backend (enable_rf → 409 while a session is active).

import { useEffect, useRef, useState } from "react";
import type { Status } from "../lib/telemetry.ts";
import { api } from "../lib/api.ts";
import { clampCap, capSettled } from "../lib/instrument.ts";
import { NanoVNAConnection } from "../lib/vna/nanovna.ts";
import { impedance, magnitude, nearestPointByFrequency, type SweepPoint } from "../lib/vna/rf.ts";
import { F0 } from "../lib/vna/autotune.ts";
import { shapeTune, dipOf } from "../lib/vna/autotune_shape.ts";
import { formatTouchstone } from "../lib/vna/touchstone.ts";

// Wide window (covers differently-tuned setups) with enough points to resolve the ~140 kHz match loop.
// A narrow 1 MHz scan returned NO data from the NanoVNA-H4 (the device took the range but the read came
// back empty), so we stay wide — which is also what the bench needs. 11–16 MHz / 401 pts = 12.5 kHz/pt
// (~11 points on the loop). If the firmware caps the point count it returns fewer (still matched), so
// this is safe. A saved log shows the actual returned count → we tune the window/resolution from data.
const SWEEP_START = 11e6;
const SWEEP_STOP = 16e6;
const POINTS = 401;
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
  const inLiveRef = useRef(false); // true while a liveLoop body is actually executing (one instance only)
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
    if (res.points.length) setSweep(res.points); // keep the last good trace if a read comes back empty
    return res.points;
  }

  async function liveLoop() {
    if (inLiveRef.current) return; // exactly one live loop may touch the shared NanoVNA link at a time
    inLiveRef.current = true;
    let fails = 0;
    try {
      while (liveRef.current) {
        if (runningRef.current) { await sleep(100); continue; }
        try {
          const points = await doSweep();
          if (points && points.length) { logSweep("live", points); if (fails) { fails = 0; setMsg(""); } }
          else if (++fails === 3) setMsg("sweep returned no data — retrying (check the NanoVNA)…");
        } catch (e) {
          if (++fails === 3) setMsg(`sweep error: ${(e as Error).message} — retrying…`);
        }
        await sleep(fails > 2 ? 500 : LIVE_GAP_MS); // a transient bad read must not blank the display or stop the loop
      }
    } finally {
      inLiveRef.current = false;
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
    // Drive the cap EXACTLY like the manual +/- buttons: a single direct command from the current
    // position — NOT approach-from-below. Backlash then lands the cap on the same side the operator
    // reaches by hand (a down-click from 36 lands ~35.8, the sweet spot; approach-from-below landed
    // 35.2 and could never match). We close the loop by measuring after each move, so we don't need
    // approach-from-below's open-loop repeatability. (2026-09-09 bench: manual +/- hit −30, auto didn't.)
    const tgt = clampCap(target);
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
    if (runningRef.current) return;            // never run two auto-tunes at once (they fight over the caps)
    const blocked = halted();
    if (blocked) { setMsg(`cannot run: ${blocked}`); return; }
    runningRef.current = true;
    setRunning(true);
    setIter(0);
    setMsg("tuning…");
    // Give the auto-tuner EXCLUSIVE use of the NanoVNA link: stop the live loop and wait for its
    // in-flight sweep to finish. Concurrent sweeps corrupt reads and let a stale loop drive the caps
    // off a good match (the 2026-09-09 "still_bad" log: a −30 dB match was wrecked mid-run).
    liveRef.current = false;
    for (let i = 0; i < 50 && inLiveRef.current; i++) await sleep(100);
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
        onStep: ({ iter: i, tune: t, load: l, dipHz, cost }) => {
          setIter(i);
          setMsg(`tuning · T${t}% L${l}% · dip ${(dipHz / 1e6).toFixed(3)}MHz → 13.560 · |Γ|${cost.toFixed(3)}`);
        },
        shouldStop: () => !runningRef.current || halted() != null,
      });
      setMsg(
        res.converged && res.iters === 0 ? `already matched — caps left at ${res.tune}% / ${res.load}%`
        : res.converged ? `matched · caps ${res.tune}% / ${res.load}% (${res.iters} steps)`
        : `stopped · caps ${res.tune}% / ${res.load}%`,
      );
    } catch (e) {
      setMsg(`run error: ${(e as Error).message}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      if (connRef.current) { liveRef.current = true; void liveLoop(); } // restart the single live loop
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
