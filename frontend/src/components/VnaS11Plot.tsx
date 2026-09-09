// Live S11 return-loss plot: |S11| in dB vs frequency across the sweep (0 dB top, −40 dB bottom, so a
// good match dips down), with the 13.56 MHz marker. Full-width; geometry from lib/vna/s11plot.ts.

import type { SweepPoint } from "../lib/vna/rf.ts";
import { s11PlotPoints, DEFAULT_PLOT } from "../lib/vna/s11plot.ts";

const W = 1000; // viewBox width; the SVG stretches to the container (preserveAspectRatio=none)

export function VnaS11Plot({ sweep, height = 150 }: { sweep: SweepPoint[]; height?: number }) {
  const box = { width: W, height, ...DEFAULT_PLOT };
  const { points, markerX } = s11PlotPoints(sweep, box);
  const yOf = (d: number) => ((DEFAULT_PLOT.dbMax - d) / (DEFAULT_PLOT.dbMax - DEFAULT_PLOT.dbMin)) * height;
  const gridDb = [0, -10, -20, -30, -40];

  return (
    <div className="vna-s11plot">
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label="S11 return loss versus frequency">
        {gridDb.map((d) => (
          <line key={d} x1={0} y1={yOf(d)} x2={W} y2={yOf(d)} stroke="var(--border, #888)" strokeWidth="1" opacity={d === -20 ? 0.55 : 0.25} />
        ))}
        <line x1={markerX} y1={0} x2={markerX} y2={height} stroke="var(--border-strong, #aaa)" strokeWidth="1.5" strokeDasharray="4 3" />
        {sweep.length > 1 && (
          <polyline points={points} fill="none" stroke="#1D9E75" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="vna-s11plot-axis" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
        <span>12 MHz</span>
        <span>|S11| dB · 0 (top) → −40 (bottom) · ▼ 13.56</span>
        <span>18 MHz</span>
      </div>
    </div>
  );
}
