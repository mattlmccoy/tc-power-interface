// useVna — owns the NanoVNA connection, the VNA session (begin / 2 s heartbeat / end), a CONTINUOUS
// live 12–18 MHz sweep (so the Smith, S11 plot and readout update in real time as the caps turn), and
// the 2-D auto-tune loop. Lives at App level so the connection survives the dashboard→tune-view switch.
// The RF interlock is enforced on the backend (enable_rf → 409 while a session is active).

import { useEffect, useRef, useState } from "react";
import type { Status } from "../lib/telemetry.ts";
import { api } from "../lib/api.ts";
import { approachFromBelow, clampCap, capSettled } from "../lib/instrument.ts";
import { NanoVNAConnection } from "../lib/vna/nanovna.ts";
import { impedance, type SweepPoint } from "../lib/vna/rf.ts";
import { gammaAt } from "../lib/vna/autotune.ts";
import { newtonTune, type Cplx } from "../lib/vna/autotune2d.ts";
import { formatTouchstone } from "../lib/vna/touchstone.ts";

const SWEEP_START = 12e6;
const SWEEP_STOP = 18e6;
const POINTS = 201;
const HEARTBEAT_MS = 2000;
const LIVE_GAP_MS = 30; // pause between live sweeps (yield to render)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const liveRef = useRef(false);
  const statusRef = useRef(status);
  const controllableRef = useRef(controllable);

  const [connected, setConnected] = useState(false);
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [iter, setIter] = useState(0);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { controllableRef.current = controllable; }, [controllable]);
  useEffect(() => () => { // App teardown: stop loops + heartbeat; never end the session (fail safe).
    runningRef.current = false;
    liveRef.current = false;
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
    const res = await conn.sweep(SWEEP_START, SWEEP_STOP, POINTS);
    setSweep(res.points);
    return res.points;
  }

  // Continuous live re-sweep while connected; pauses itself during an auto-tune run.
  async function liveLoop() {
    while (liveRef.current) {
      if (runningRef.current) { await sleep(100); continue; }
      try {
        await doSweep();
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
      await api.vnaBegin(); // fail-safe: a VNA connected in the tool ⇒ RF locked
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

  // 2-D auto-tune: pause the live loop, drive the caps together toward Z=50+j0 (newtonTune), resume.
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

    const probe = async (tune: number, load: number): Promise<Cplx> => {
      if (tune !== curT) { await driveCap("tune", tune); curT = tune; }
      if (load !== curL) { await driveCap("load", load); curL = load; }
      const points = await doSweep();
      const p = points ? gammaAt(points) : null;
      return p ? impedance(p.s11, 50) : { re: 0, im: 1e6 }; // no reading ⇒ never "converged"
    };

    try {
      const res = await newtonTune(probe, start, {
        onStep: ({ iter: i, cost }) => { setIter(i); setMsg(`tuning · |Γ|=${cost.toFixed(3)}`); },
        shouldStop: () => !runningRef.current || halted() != null,
      });
      setMsg(res.converged ? `matched · caps ${res.tune}% / ${res.load}%` : `stopped · caps ${res.tune}% / ${res.load}%`);
    } catch (e) {
      setMsg(`run error: ${(e as Error).message}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      if (connRef.current && !liveRef.current) { liveRef.current = true; void liveLoop(); } // resume live
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
