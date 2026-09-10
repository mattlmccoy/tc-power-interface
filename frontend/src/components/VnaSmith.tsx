// S11 Smith chart: the constant-R / constant-X grid, the full swept trace, the 50 Ω centre, and the
// 13.56 MHz marker. Pure geometry from lib/vna/smith.ts; the viewBox is a fixed 200-unit square so
// `size` just scales it. Reused by the dashboard entry card and the full VNA tune view.

import { useId } from "react";
import type { SweepPoint } from "../lib/vna/rf.ts";
import { interpS11At, F0 } from "../lib/vna/autotune_shape.ts";
import { gammaToXY, constResistanceCircle, constReactanceCircle, RESISTANCE_GRID, REACTANCE_GRID } from "../lib/vna/smith.ts";

const FR = { cx: 100, cy: 100, r: 90 };

export function VnaSmith({ sweep, size = 200 }: { sweep: SweepPoint[]; size?: number }) {
  const clipId = `smith-${useId()}`;
  const s11 = sweep.length ? interpS11At(sweep, F0) : null; // marker at exactly 13.56 (interpolated)
  const tracePts = sweep
    .map((pt) => gammaToXY(pt.s11, FR))
    .map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`)
    .join(" ");
  const mk = s11 ? gammaToXY(s11, FR) : null;

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label="S11 Smith chart">
      <defs><clipPath id={clipId}><circle cx={FR.cx} cy={FR.cy} r={FR.r} /></clipPath></defs>
      <g clipPath={`url(#${clipId})`} fill="none" stroke="var(--border, #888)" strokeWidth="0.6" opacity="0.6">
        {RESISTANCE_GRID.map((rn) => {
          const c = constResistanceCircle(rn, FR);
          return <circle key={`r${rn}`} cx={c.cx} cy={c.cy} r={c.r} />;
        })}
        {REACTANCE_GRID.flatMap((xn) => [xn, -xn]).map((xn) => {
          const c = constReactanceCircle(xn, FR);
          return <circle key={`x${xn}`} cx={c.cx} cy={c.cy} r={c.r} />;
        })}
      </g>
      <circle cx={FR.cx} cy={FR.cy} r={FR.r} fill="none" stroke="var(--border-strong, #aaa)" strokeWidth="1" />
      <line x1={FR.cx - FR.r} y1={FR.cy} x2={FR.cx + FR.r} y2={FR.cy} stroke="var(--border-strong, #aaa)" strokeWidth="0.6" />
      {sweep.length > 1 && (
        <polyline points={tracePts} fill="none" stroke="#1D9E75" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${clipId})`} />
      )}
      <circle cx={FR.cx} cy={FR.cy} r="2.5" fill="var(--live, #2b8a3e)" />
      {mk && <circle cx={mk.x} cy={mk.y} r="5" fill="var(--err-btn, #c92a2a)" stroke="var(--surface-1, #fff)" strokeWidth="0.8" />}
    </svg>
  );
}
