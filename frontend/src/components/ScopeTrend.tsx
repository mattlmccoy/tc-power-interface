import { useEffect, useRef } from "react";

import type { TrendPoint } from "../lib/scopeView.ts";

interface Props {
  points: TrendPoint[];
  windowS: number;
  vCeil: number;
  bCeil: number;
  probeWarnV: number;
  fluxStopMt: number;
}

const css = (el: Element, name: string, dflt: string) =>
  getComputedStyle(el).getPropertyValue(name).trim() || dflt;

/** Dual-axis strip: loop Vrms (left, amber) and B_pk (right, blue) over the last windowS seconds.
 * A null point lifts the pen, so RF-off / invalid / stalled stretches are gaps, never zeros. */
export function ScopeTrend({ points, windowS, vCeil, bCeil, probeWarnV, fluxStopMt }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const fwd = css(canvas, "--trace-fwd", "#ffb454");
    const refl = css(canvas, "--trace-refl", "#6ec3ff");
    const warn = css(canvas, "--warn", "#ffb454");
    const err = css(canvas, "--err", "#ff5f56");
    const muted = css(canvas, "--muted", "#8b97a5");
    const font = css(canvas, "--font-mono", "monospace");

    const padL = 34;
    const padR = 40;
    const padT = 6;
    const padB = 6;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const x = (t: number) => padL + ((t + windowS) / windowS) * pw;
    const yOf = (v: number, ceil: number) => padT + ph - Math.min(1, Math.max(0, v / ceil)) * ph;

    // grid + axis labels
    ctx.font = `9px ${font}`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ph * i) / 4;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
      const f = 1 - i / 4;
      ctx.fillStyle = fwd;
      ctx.textAlign = "right";
      ctx.fillText(`${Math.round(vCeil * f)}`, padL - 4, y);
      ctx.fillStyle = refl;
      ctx.textAlign = "left";
      ctx.fillText((bCeil * f).toFixed(1), padL + pw + 4, y);
    }
    ctx.fillStyle = muted;
    ctx.textAlign = "left";
    ctx.fillText(`−${Math.round(windowS / 60)} min`, padL + 3, padT + ph - 6);
    ctx.textAlign = "right";
    ctx.fillText("now", padL + pw - 3, padT + ph - 6);

    // dashed reference lines
    const refLine = (v: number, ceil: number, color: string) => {
      const y = yOf(v, ceil);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
      ctx.restore();
    };
    refLine(probeWarnV, vCeil, warn);
    refLine(fluxStopMt, bCeil, err);

    const trace = (pick: (p: TrendPoint) => number | null, ceil: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      let pen = false;
      ctx.beginPath();
      points.forEach((p, i) => {
        const v = pick(p);
        if (v == null) {
          pen = false;
          return;
        }
        const px = x(p.t);
        const py = yOf(v, ceil);
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        // isolated sample (no neighbours drawn): mark it so it is not invisible
        const prev = points[i - 1];
        const next = points[i + 1];
        if ((!prev || pick(prev) == null) && (!next || pick(next) == null)) ctx.fillRect(px - 1, py - 1, 2, 2);
        pen = true;
      });
      ctx.stroke();
    };
    trace((p) => p.v, vCeil, fwd);
    trace((p) => p.b, bCeil, refl);
  }, [points, windowS, vCeil, bCeil, probeWarnV, fluxStopMt]);

  return <canvas ref={ref} className="plot sl-trend" />;
}
