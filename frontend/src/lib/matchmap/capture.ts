// Runs a capture plan against injected hardware actions (move a cap, wait for it to settle, measure),
// so the sequencing is testable without a NanoVNA or generator. useVna supplies the real actions.

import type { Complex } from "../vna/rf.ts";
import { zOfGamma, type MapPoint } from "./fit.ts";
import type { Step } from "./plan.ts";

export interface ReadSample { t: number; tune: number | null; load: number | null }

/** The readback is settled when the history covers the whole window (a sample at or before
 *  now − windowMs) and, within that window, both caps stay inside `deadband` (absorbs the ±0.1 %
 *  quantization flicker) with no missing readings. */
export function isStable(hist: ReadSample[], now: number, windowMs: number, deadband: number): boolean {
  const from = now - windowMs;
  if (!hist.some((s) => s.t <= from)) return false;
  let anchor = -1;
  for (let i = 0; i < hist.length; i++) if (hist[i].t <= from) anchor = i;
  const win = hist.slice(anchor).filter((s) => s.t <= now);
  for (const axis of ["tune", "load"] as const) {
    const v = win.map((s) => s[axis]);
    if (v.some((x) => x == null || !Number.isFinite(x))) return false;
    const n = v as number[];
    if (Math.max(...n) - Math.min(...n) > deadband + 1e-9) return false;
  }
  return true;
}

export function averageGamma(gs: Complex[]): Complex {
  const n = gs.length;
  const r = gs.reduce((a, g) => ({ re: a.re + g.re, im: a.im + g.im }), { re: 0, im: 0 });
  return { re: Math.round((r.re / n) * 1e12) / 1e12, im: Math.round((r.im / n) * 1e12) / 1e12 };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface CapturedPoint extends MapPoint {
  label: string;
  cmdTune: number;
  cmdLoad: number;
  repeat: boolean;
  t: number;
}

export interface CaptureDeps {
  move: (axis: "tune" | "load", value: number) => Promise<void>;
  settle: () => Promise<void>;
  measure: () => Promise<MapPoint>; // averaged Γ at 13.56 MHz + the readback during the measurement
  shouldStop: () => boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function runCapture(steps: Step[], deps: CaptureDeps): Promise<{ points: CapturedPoint[]; stopped: boolean }> {
  const total = steps.filter((s) => s.kind === "record").length;
  const points: CapturedPoint[] = [];
  for (const s of steps) {
    if (deps.shouldStop()) return { points, stopped: true };
    if (s.kind === "move") {
      await deps.move(s.axis, s.value);
      await deps.settle();
      continue;
    }
    deps.onProgress?.(points.length, total, s.label);
    const m = await deps.measure();
    points.push({ ...m, label: s.label, cmdTune: s.tune, cmdLoad: s.load, repeat: s.repeat, t: Date.now() });
    deps.onProgress?.(points.length, total, s.label);
  }
  return { points, stopped: false };
}

/** Drift check: |ΔZ| (Ohm) between the closing repeat and the first visit to the same commanded point,
 *  or null without a repeat. Larger than the map's own error means the network moved during capture. */
export function repeatDriftOhm(points: CapturedPoint[]): number | null {
  const rep = points.find((p) => p.repeat);
  const first = rep && points.find((p) => !p.repeat && p.cmdTune === rep.cmdTune && p.cmdLoad === rep.cmdLoad);
  if (!rep || !first) return null;
  const a = zOfGamma(rep.g), b = zOfGamma(first.g);
  return Math.hypot(a.re - b.re, a.im - b.im);
}

/** Ohm two sweeps at one point may differ and still be one measurement (fresh sweeps agree to ~0.05). */
export const SWEEP_AGREE_OHM = 1;

/** Combine the sweeps taken at one map point, or null when another sweep is needed: two that agree
 *  within SWEEP_AGREE_OHM → their mean; two that disagree → wait for a third, then the component-wise
 *  median (a one-read glitch is voted out). Saves a sweep per point vs always taking three. */
export function pointFromSweeps(gs: Complex[]): Complex | null {
  if (gs.length < 2) return null;
  if (gs.length === 2) {
    const [a, b] = gs.map(zOfGamma);
    if (Math.hypot(a.re - b.re, a.im - b.im) > SWEEP_AGREE_OHM) return null;
    return { re: (gs[0].re + gs[1].re) / 2, im: (gs[0].im + gs[1].im) / 2 };
  }
  const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1];
  const last3 = gs.slice(-3);
  return { re: med(last3.map((g) => g.re)), im: med(last3.map((g) => g.im)) };
}
