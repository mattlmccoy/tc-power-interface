// Pure geometry for the S11 return-loss plot: |S11| in dB versus frequency across the sweep, mapped
// into an SVG box (0 dB at the top, dbMin at the bottom, so a deep match dips DOWNWARD). Also returns
// the x of the 13.56 MHz marker. Rendered by components/VnaS11Plot.tsx.

import { db, type SweepPoint } from "./rf.ts";

export const F0 = 13.56e6;

export interface PlotBox {
  width: number;
  height: number;
  dbMin: number; // bottom of the axis (e.g. −40)
  dbMax: number; // top of the axis (e.g. 0)
  fMin: number;
  fMax: number;
}

export const DEFAULT_PLOT = { dbMin: -40, dbMax: 0, fMin: 12e6, fMax: 18e6 } as const;

export function s11PlotPoints(sweep: SweepPoint[], box: PlotBox): { points: string; markerX: number } {
  const xOf = (f: number) => ((f - box.fMin) / (box.fMax - box.fMin)) * box.width;
  const yOf = (d: number) => {
    const c = Math.max(box.dbMin, Math.min(box.dbMax, d));
    return ((box.dbMax - c) / (box.dbMax - box.dbMin)) * box.height;
  };
  const points = sweep.map((p) => `${xOf(p.frequency).toFixed(1)},${yOf(db(p.s11)).toFixed(1)}`).join(" ");
  return { points, markerX: xOf(F0) };
}
