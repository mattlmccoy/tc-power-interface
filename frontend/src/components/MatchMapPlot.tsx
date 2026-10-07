// Canvas plot for the in-run match aid: Tune (x) × Load (y) readback percent.
//   background — the COLD map's return loss (where the match was before heating)
//   light      — candidate positions of the drifted match, from recent readings
//   markers    — cold match (×), estimate (○), readings (•, with W), current readback (●)

import { useEffect, useRef } from "react";
import { predictGammaMag } from "../lib/matchmap/fit.ts";
import { CELL, showCandidates, type LocateResult } from "../lib/matchmap/locate.ts";
import type { LoadedMap } from "../lib/matchmap/store.ts";
import type { Reading } from "../lib/matchmap/track.ts";

const W = 420, H = 300, PAD = { l: 44, r: 10, t: 10, b: 30 };

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function MatchMapPlot({ map, result, readings, current }: {
  map: LoadedMap;
  result: LocateResult;
  readings: Reading[];
  current: { tune: number; load: number } | null;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = {
      bg: cssVar("--bg-deep", "#111"), fg: cssVar("--fg", "#ddd"), muted: cssVar("--muted", "#888"),
      live: cssVar("--live", "#3c3"), warn: cssVar("--warn", "#fa0"), err: cssVar("--err", "#f44"),
      accent: cssVar("--accent", "#4af"), line: cssVar("--line", "#333"),
    };
    const { tune, load } = result.grid;
    const tLo = tune[0], tHi = tune[tune.length - 1], lLo = load[0], lHi = load[load.length - 1];
    const x = (t: number) => PAD.l + ((t - tLo) / (tHi - tLo)) * (W - PAD.l - PAD.r);
    const y = (l: number) => H - PAD.b - ((l - lLo) / (lHi - lLo)) * (H - PAD.t - PAD.b);
    const cw = (W - PAD.l - PAD.r) / (tune.length - 1), ch = (H - PAD.t - PAD.b) / (load.length - 1);

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    tune.forEach((t, i) => load.forEach((l, j) => {
      const rl = -20 * Math.log10(Math.max(predictGammaMag(map.fit, t, l), 1e-6));
      const band = rl >= 20 ? [c.live, 0.45] : rl >= 15 ? [c.live, 0.2] : rl >= 10 ? [c.warn, 0.16] : null;
      const cell = result.cells[i * load.length + j];
      if (band) { ctx.globalAlpha = band[1] as number; ctx.fillStyle = band[0] as string; ctx.fillRect(x(t) - cw / 2, y(l) - ch / 2, cw + 0.5, ch + 0.5); }
      if (showCandidates(result) && cell === CELL.outside) { ctx.globalAlpha = 0.12; ctx.fillStyle = c.muted; ctx.fillRect(x(t) - cw / 2, y(l) - ch / 2, cw + 0.5, ch + 0.5); }
    }));
    ctx.globalAlpha = 1;

    // Possible match positions: an OUTLINE (cells on the edge of the consistent set), only while searching.
    // Filled, it looked like more map — and it is the map turned 180° about the halfway point (2026-10-06).
    if (showCandidates(result)) {
      const nL = load.length, at = (i: number, j: number) => result.cells[i * nL + j] === CELL.consistent;
      ctx.fillStyle = c.fg;
      tune.forEach((t, i) => load.forEach((l, j) => {
        if (!at(i, j)) return;
        const edge = i === 0 || j === 0 || i === tune.length - 1 || j === nL - 1 || !at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1);
        if (edge) ctx.fillRect(x(t) - cw / 2, y(l) - ch / 2, cw + 0.5, ch + 0.5);
      }));
    }

    // axes: whole-percent ticks
    ctx.strokeStyle = c.line; ctx.fillStyle = c.muted; ctx.font = "10px ui-monospace, monospace"; ctx.lineWidth = 1;
    ctx.strokeRect(PAD.l, PAD.t, W - PAD.l - PAD.r, H - PAD.t - PAD.b);
    const step = (span: number) => (span > 12 ? 4 : span > 6 ? 2 : 1);
    for (let t = Math.ceil(tLo); t <= tHi; t += step(tHi - tLo)) { ctx.fillText(String(t), x(t) - 6, H - PAD.b + 12); }
    for (let l = Math.ceil(lLo); l <= lHi; l += step(lHi - lLo)) { ctx.fillText(String(l), 18, y(l) + 3); }
    ctx.fillText("Tune %", W / 2 - 18, H - 4);
    ctx.save(); ctx.translate(10, (H - PAD.b) / 2 + 20); ctx.rotate(-Math.PI / 2); ctx.fillText("Load %", 0, 0); ctx.restore();

    // cold match ×
    const cx = x(map.coldMatch.tune), cy = y(map.coldMatch.load);
    ctx.strokeStyle = c.fg; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - 5, cy - 5); ctx.lineTo(cx + 5, cy + 5); ctx.moveTo(cx + 5, cy - 5); ctx.lineTo(cx - 5, cy + 5); ctx.stroke();
    // estimate ○ (dashed when it is only a ring's centroid)
    if (result.estimate && result.status === "spot") {
      ctx.strokeStyle = c.accent; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x(result.estimate.tune), y(result.estimate.load), 8, 0, 2 * Math.PI); ctx.stroke();
    }
    // readings • with reflected watts
    ctx.fillStyle = c.fg;
    for (const r of readings) {
      ctx.beginPath(); ctx.arc(x(r.tune), y(r.load), 2.5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillText(`${r.rev.toFixed(1)}W`, x(r.tune) + 5, y(r.load) - 4);
    }
    // current readback ●
    if (current) {
      const g = readings.length ? readings[readings.length - 1].g : 0;
      ctx.fillStyle = g < 0.1 ? c.live : g < 0.2 ? c.warn : c.err;
      ctx.strokeStyle = c.bg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x(current.tune), y(current.load), 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
  }, [map, result, readings, current?.tune, current?.load]);

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", maxWidth: W, aspectRatio: `${W} / ${H}`, display: "block", borderRadius: 6 }}
      aria-label="Match map: cold return-loss bands, drifted-match candidates, readings and current cap readback"
    />
  );
}
