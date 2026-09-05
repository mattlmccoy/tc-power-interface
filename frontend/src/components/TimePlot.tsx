import { useEffect, useRef } from "react";

import type { Point } from "../lib/telemetry.ts";

interface Props {
  forward: Point[];
  reflectedPct: Point[];
  powerCeil: number;
  reflectCeil: number;
}

/** Dual-trace strip chart: forward power (amber) and reflected fraction % (blue). */
export function TimePlot({ forward, reflectedPct, powerCeil, reflectCeil }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const drawTrace = (pts: Point[], ceil: number, color: string) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = (w * i) / (pts.length - 1);
        const y = h - Math.min(1, p.v / ceil) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawTrace(forward, powerCeil, "#ffb454");
    drawTrace(reflectedPct, reflectCeil, "#6ec3ff");
  }, [forward, reflectedPct, powerCeil, reflectCeil]);

  return <canvas ref={ref} className="plot" />;
}
