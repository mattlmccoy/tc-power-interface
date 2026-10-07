// Canvas drawing for the cockpit run timeline: a port of mockup v4 `draw()` (scratchpad
// mockup/script4.js) onto the live history buffer. Scales, windows and ticks come from the pure,
// tested helpers in lib/cockpit/timeline.ts; this file only paints. Unknown values leave gaps.

import { mmss } from "../../lib/cockpit/format.ts";
import type { CockpitSample } from "../../lib/cockpit/history.ts";
import { gapSegments, minMaxIndices } from "../../lib/cockpit/plotPrep.ts";
import { axisStep, tempRange, tickStep, timeWindow, type WindowMode } from "../../lib/cockpit/timeline.ts";

/** Longer than this between samples = the link dropped: lines lift and the forward fill breaks
 *  (the same 5 s as runStats in lib/cockpit/live.ts). */
const MAX_GAP_S = 5;

/** Watched-ROI colours and dashes, in watch order (mockup v4). The first is the --ck-core token. */
export const WATCH_COLORS = ["var(--ck-core)", "#f78c6c", "#c3e88d", "#82aaff"];
export const WATCH_DASH: number[][] = [[], [2, 3], [6, 3], [1, 2]];
const REFL_MAX_PCT = 6; // right axis: reflected % of forward, clamped (mockup v4)

export interface TimelineInput {
  buf: CockpitSample[];
  win: WindowMode;
  watch: string[];
  /** Dashed temperature lines: the target and/or the levels-off plateau. */
  hlines: { c: number; kind: "target" | "plateau" }[];
  /** Draw the shadow suggestion (to-temperature mode with shadow.show). */
  showSuggest: boolean;
  retunes: number[];
  /** Replay: the cursor (ns from the run start). The whole run is shown, the future greyed. */
  cursorNs?: number | null;
}

function css(el: Element, v: string): string {
  if (!v.startsWith("var(")) return v;
  return getComputedStyle(el).getPropertyValue(v.slice(4, -1)).trim() || "#888";
}

export function drawTimeline(cv: HTMLCanvasElement, inp: TimelineInput): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (W <= 0 || H <= 0) return;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const col = (v: string) => css(cv, v);
  ctx.font = "10px 'Space Mono', ui-monospace, monospace";

  const { buf } = inp;
  if (!buf.length) {
    ctx.fillStyle = col("var(--muted)");
    ctx.textAlign = "center";
    ctx.fillText("No telemetry yet: the timeline fills as samples arrive.", W / 2, H / 2);
    ctx.textAlign = "start";
    return;
  }
  const t0 = buf[0].ns;
  const ts = (s: CockpitSample) => (s.ns - t0) / 1e9;
  const range = timeWindow(ts(buf[buf.length - 1]), inp.cursorNs != null ? "all" : inp.win, 0);
  if (!range) return;
  const [tStart, tEnd] = range;
  const L = 44, R = 46, top = 8, split = Math.round(H * 0.6), bot = H - 18;
  const span = Math.max(tEnd - tStart, 60);
  const plotW = W - L - R;
  const X = (t: number) => L + ((t - tStart) / span) * plotW;
  const vis = buf.filter((s) => ts(s) >= tStart && ts(s) <= tEnd);

  const temps: (number | null)[] = [];
  for (const s of vis) {
    temps.push(s.part);
    for (const w of inp.watch) temps.push(s.watch[w] ?? null);
  }
  const [tLo, tHi] = tempRange(temps, inp.hlines.map((h) => h.c));
  const Yt = (c: number) => top + (1 - (c - tLo) / (tHi - tLo)) * (split - 14 - top);
  let pMax = 40;
  for (const s of vis) {
    if (Number.isFinite(s.fwd)) pMax = Math.max(pMax, s.fwd);
    if (inp.showSuggest && s.suggest != null) pMax = Math.max(pMax, s.suggest);
  }
  const pHi = Math.ceil(pMax / 20) * 20 + 10;
  const Yp = (w: number) => split + 4 + (1 - w / pHi) * (bot - split - 4);
  const Yr = (p: number) => split + 4 + (1 - Math.min(p, REFL_MAX_PCT) / REFL_MAX_PCT) * (bot - split - 4);

  // Grid + axes.
  ctx.fillStyle = col("var(--muted)");
  ctx.strokeStyle = col("var(--line)");
  ctx.lineWidth = 1;
  const tstep = axisStep(tHi - tLo, split - 14 - top);
  if (tstep !== null) {
    for (let c = Math.ceil(tLo / tstep) * tstep; c <= tHi; c += tstep) {
      ctx.beginPath(); ctx.moveTo(L, Yt(c)); ctx.lineTo(W - R, Yt(c)); ctx.stroke();
      ctx.fillText(`${Number(c.toFixed(1))}°`, 6, Yt(c) + 3);
    }
  }
  const pstep = axisStep(pHi, bot - split - 4);
  if (pstep !== null) {
    for (let w = 0; w <= pHi; w += pstep) {
      ctx.beginPath(); ctx.moveTo(L, Yp(w)); ctx.lineTo(W - R, Yp(w)); ctx.stroke();
      ctx.fillText(`${w}W`, 6, Yp(w) + 3);
    }
  }
  for (const p of [0, 2, 4, 6]) ctx.fillText(`${p}%`, W - R + 6, Yr(p) + 3);
  const tick = tickStep(span, plotW);
  if (tick !== null) {
    for (let s = Math.ceil(tStart / tick) * tick; s <= tEnd; s += tick) ctx.fillText(mmss(s), X(s) - 12, H - 4);
  }

  const hline = (y: number, color: string) => {
    ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.setLineDash([]);
  };
  for (const h of inp.hlines) hline(Yt(h.c), col(h.kind === "target" ? "var(--live)" : "var(--ck-shadow)"));

  // Times of the visible samples, the gap-free runs, and one pixel bucket per plot pixel. Dense
  // series are thinned to the min and max per pixel (peaks survive; ~2 points per pixel).
  const vt = vis.map(ts);
  const segs = gapSegments(vt, MAX_GAP_S);
  const buckets = Math.max(1, Math.round(plotW));
  const keep = (vals: (number | null)[], a: number, b: number) => minMaxIndices(vt, vals, a, b, tStart, span, buckets);
  const line = (val: (s: CockpitSample) => number | null, Y: (v: number) => number, color: string, dash: number[], alpha: number) => {
    const vals = vis.map(val);
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash); ctx.beginPath();
    for (const [a, b] of segs) {
      let pen = false; // a gap lifts the pen
      for (const i of keep(vals, a, b)) {
        const v = vals[i];
        if (v == null || !Number.isFinite(v)) { pen = false; continue; }
        if (pen) ctx.lineTo(X(vt[i]), Y(v)); else ctx.moveTo(X(vt[i]), Y(v));
        pen = true;
      }
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  };

  // Power lane: filled forward (one fill per gap-free run, unknown forward = no fill), then its line.
  const fwdCol = col("var(--trace-fwd)");
  const fwdVals = vis.map((s) => (Number.isFinite(s.fwd) ? s.fwd : null));
  ctx.fillStyle = fwdCol; ctx.globalAlpha = 0.18;
  for (const [a, b] of segs) {
    let open = false, lastX = 0;
    const close = () => { if (open) { ctx.lineTo(lastX, Yp(0)); ctx.closePath(); ctx.fill(); open = false; } };
    for (const i of keep(fwdVals, a, b)) {
      const v = fwdVals[i];
      if (v == null) { close(); continue; }
      const x = X(vt[i]);
      if (!open) { ctx.beginPath(); ctx.moveTo(x, Yp(0)); open = true; }
      ctx.lineTo(x, Yp(v)); lastX = x;
    }
    close();
  }
  ctx.globalAlpha = 1;
  line((s) => s.fwd, Yp, fwdCol, [], 0.7);
  if (inp.showSuggest) line((s) => s.suggest, Yp, col("var(--ck-shadow)"), [5, 4], 0.9);
  line((s) => (s.rf && s.fwd > 1 ? (100 * s.rev) / s.fwd : null), Yr, col("var(--trace-refl)"), [], 0.9);

  // Temperature lane: watched ROIs under the part.
  inp.watch.forEach((w, k) => line((s) => s.watch[w] ?? null, Yt, col(WATCH_COLORS[k % 4]), WATCH_DASH[k % 4], 0.8));
  line((s) => s.part, Yt, col("var(--accent)"), [], 1);

  // Retune ticks just above the power lane.
  ctx.fillStyle = col("var(--fg)");
  for (const ns of inp.retunes) {
    const t = (ns - t0) / 1e9;
    if (t >= tStart && t <= tEnd) ctx.fillRect(X(t) - 1, split - 10, 2, 8);
  }

  // Replay: grey the future, draw the cursor, and mark the part reading at it.
  if (inp.cursorNs != null) {
    const ct = inp.cursorNs / 1e9;
    const cx = Math.max(L, Math.min(W - R, X(ct)));
    ctx.fillStyle = col("var(--bg)"); ctx.globalAlpha = 0.72;
    ctx.fillRect(cx + 1, 0, W - R - cx, H - 16); ctx.globalAlpha = 1;
    ctx.strokeStyle = col("var(--fg-strong)"); ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H - 16); ctx.stroke();
    let at: CockpitSample | undefined;
    for (const s of vis) { if ((s.ns - t0) / 1e9 <= ct) at = s; else break; }
    if (at && at.part != null && Number.isFinite(at.part)) {
      ctx.fillStyle = col("var(--accent)");
      ctx.beginPath(); ctx.arc(cx, Yt(at.part), 4, 0, 7); ctx.fill();
    }
    return;
  }
  // "Now": the latest part reading.
  const last = vis[vis.length - 1];
  if (last && last.part != null && Number.isFinite(last.part)) {
    ctx.fillStyle = col("var(--accent)");
    ctx.beginPath(); ctx.arc(X(ts(last)), Yt(last.part), 4, 0, 7); ctx.fill();
  }
}
