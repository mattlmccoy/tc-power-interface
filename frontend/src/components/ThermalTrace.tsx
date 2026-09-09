import type { Point } from "../lib/telemetry.ts";
import { fitRange, polyline, yOf } from "../lib/heroTrace.ts";

interface ThermalTraceProps {
  control: Point[];
  max: Point[];
  roi: { name: string; points: Point[] }[];
  showOverlay: boolean;
  targetC: number;
  bandC: number;
}

// viewBox units; the SVG scales to its container via width:100% (preserveAspectRatio none).
const W = 720;
const H = 260;

export function ThermalTrace({ control, max, roi, showOverlay, targetC, bandC }: ThermalTraceProps) {
  const cv = control.map((p) => p.v);
  const mv = max.map((p) => p.v);
  const r = fitRange(cv, mv, targetC);
  const yTarget = yOf(targetC, r, H);
  const yBandHi = yOf(targetC + bandC, r, H);
  const yBandLo = yOf(targetC - bandC, r, H);
  return (
    <svg className="hero-trace" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label="control-ROI temperature versus target over time">
      {/* approach band around the target */}
      <rect x="0" y={yBandHi} width={W} height={Math.max(0, yBandLo - yBandHi)} className="hero-band" />
      {/* target reference */}
      <line x1="0" y1={yTarget} x2={W} y2={yTarget} className="hero-target" />
      {/* other live ROIs — faint, toggle */}
      {showOverlay
        ? roi.map((s) => (
            <polyline key={s.name} className="hero-roi" fill="none"
              points={polyline(s.points.map((p) => p.v), r, W, H)} />
          ))
        : null}
      {/* control ROI max_c — over-temp awareness; only when the field is present */}
      {mv.length > 0 ? <polyline className="hero-max" fill="none" points={polyline(mv, r, W, H)} /> : null}
      {/* control ROI mean_c — the controlled signal (thick, live) */}
      <polyline className="hero-control" fill="none" points={polyline(cv, r, W, H)} />
    </svg>
  );
}
