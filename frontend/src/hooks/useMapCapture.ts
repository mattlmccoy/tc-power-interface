// Cold match-map capture, run from the VNA view (RF interlocked off by the VNA session). Steps the caps
// through the default grid around the current position (plan.ts), waits for the READBACK to settle,
// averages 3 sweeps at exactly 13.56 MHz, fits the map and makes it the active one for the in-run aid.
// The pure sequencing lives in lib/matchmap; this hook supplies the real move / settle / measure.

import { useEffect, useRef, useState } from "react";
import type { Operator } from "./useOperator.ts";
import type { VnaController } from "./useVna.ts";
import { F0 } from "../lib/vna/autotune.ts";
import { interpS11At } from "../lib/vna/autotune_shape.ts";
import { f0GridOffsetHz } from "../lib/vna/sweep.ts";
import type { Complex } from "../lib/vna/rf.ts";
import { settingsStorage } from "../lib/settings_store.ts";
import { VERSION_FULL } from "../version.ts";
import { capturePlan, DEFAULT_LOAD_OFFSETS, DEFAULT_TUNE_OFFSETS } from "../lib/matchmap/plan.ts";
import { averageGamma, isStable, median, repeatDriftOhm, runCapture, type ReadSample } from "../lib/matchmap/capture.ts";
import { MAP_EVENT, parseMap, saveActiveMap, serializeMap, type LoadedMap } from "../lib/matchmap/store.ts";

const SETTLE_WINDOW_MS = 1500; // readback must hold this long…
const SETTLE_DEADBAND = 0.15; // …within this (absorbs the ±0.1 % flicker)
const SETTLE_MIN_MS = 800; // the motor needs a moment to start; don't call an unstarted move "settled"
const SETTLE_TIMEOUT_MS = 20000;
const SWEEPS_PER_POINT = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface MapCapture {
  busy: boolean;
  progress: { done: number; total: number; label: string } | null;
  msg: string;
  result: LoadedMap | null;
  driftOhm: number | null;
  start: (label: string) => Promise<void>;
  download: () => void;
}

export function useMapCapture(op: Operator, vna: VnaController): MapCapture {
  const telRef = useRef(op.status?.controller?.telemetry ?? null);
  const okRef = useRef(op.controllable);
  useEffect(() => { telRef.current = op.status?.controller?.telemetry ?? null; }, [op.status]);
  useEffect(() => { okRef.current = op.controllable; }, [op.controllable]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<MapCapture["progress"]>(null);
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<LoadedMap | null>(null);
  const [driftOhm, setDriftOhm] = useState<number | null>(null);
  const textRef = useRef<string | null>(null);

  const blocked = () => (!okRef.current ? "generator not armed" : telRef.current?.rf_on ? "RF is on" : null);
  const shouldStop = () => !vna.isRunning() || blocked() != null;

  async function settle() {
    const hist: ReadSample[] = [];
    const t0 = Date.now();
    for (;;) {
      const now = Date.now();
      const tel = telRef.current;
      hist.push({ t: now, tune: tel?.tune_cap_percent ?? null, load: tel?.load_cap_percent ?? null });
      if (now - t0 >= SETTLE_MIN_MS && isStable(hist, now, SETTLE_WINDOW_MS, SETTLE_DEADBAND)) return;
      if (shouldStop()) return; // runCapture stops before the next step
      if (now - t0 > SETTLE_TIMEOUT_MS) throw new Error(`cap readback did not settle within ${SETTLE_TIMEOUT_MS / 1000} s`);
      await sleep(200);
    }
  }

  async function measure() {
    const gs: Complex[] = [], ts: number[] = [], ls: number[] = [];
    for (let k = 0; k < SWEEPS_PER_POINT + 2 && gs.length < SWEEPS_PER_POINT; k++) {
      const pts = await vna.doSweep();
      if (!pts?.length) continue;
      const off = f0GridOffsetHz(pts, F0);
      if (off == null || off > 1) {
        throw new Error(`13.56 MHz is not a measured sweep point (nearest is ${off} Hz away) — the map needs the exact value`);
      }
      const s = interpS11At(pts, F0);
      const tel = telRef.current;
      if (!s || tel?.tune_cap_percent == null || tel?.load_cap_percent == null) continue;
      vna.logMapSweep(pts);
      gs.push(s);
      ts.push(tel.tune_cap_percent);
      ls.push(tel.load_cap_percent);
    }
    if (gs.length < SWEEPS_PER_POINT) throw new Error(`only ${gs.length} good sweeps at this point`);
    return { tune: median(ts), load: median(ls), g: averageGamma(gs) };
  }

  async function start(label: string) {
    const why = blocked();
    if (why) { setMsg(`cannot capture: ${why}`); return; }
    const tel = telRef.current;
    if (tel?.tune_cap_percent == null || tel?.load_cap_percent == null) { setMsg("cannot capture: no cap readback"); return; }
    const plan = capturePlan(tel.tune_cap_percent, tel.load_cap_percent, DEFAULT_TUNE_OFFSETS, DEFAULT_LOAD_OFFSETS);
    setBusy(true); setResult(null); setDriftOhm(null); textRef.current = null;
    setMsg("capturing — the caps will step around this point, then return to it");
    try {
      const res = await vna.exclusive(() => runCapture(plan, {
        move: (axis, v) => (axis === "tune" ? op.sendTune(v) : op.sendLoad(v)),
        settle, measure, shouldStop,
        onProgress: (done, total, lbl) => setProgress({ done, total, label: lbl }),
      }));
      if (res === null) { setMsg("VNA is busy (auto-tune running?) — try again when it finishes"); return; }
      if (res.stopped) { setMsg(`stopped after ${res.points.length} points — no map saved; caps left where they are`); return; }
      const text = serializeMap({ label: label.trim() || "unlabelled", build: VERSION_FULL, createdAt: new Date().toISOString(), points: res.points });
      textRef.current = text; // downloadable even if the fit fails, so the measurements aren't lost
      const m = parseMap(text);
      saveActiveMap(settingsStorage(), text);
      window.dispatchEvent(new Event(MAP_EVENT));
      setResult(m);
      setDriftOhm(repeatDriftOhm(res.points));
      setMsg("map saved as the active map — re-check the match before ending the session (the return may land a little off)");
    } catch (e) {
      setMsg(`capture failed: ${(e as Error).message}${textRef.current ? " (raw points can still be downloaded)" : ""}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function download() {
    const text = textRef.current;
    if (!text) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `match-map-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  return { busy, progress, msg, result, driftOhm, start, download };
}
