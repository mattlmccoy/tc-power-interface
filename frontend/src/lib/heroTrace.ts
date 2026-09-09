// Pure geometry for the closed-loop hero trace: fit a temperature y-range and map samples to SVG
// coordinates. No DOM, no React — unit-tested in heroTrace.test.ts; the SVG element is ThermalTrace.

export interface Range {
  lo: number;
  hi: number;
}

/** Auto-fit a temperature y-range that always includes `target` and any finite control/max value,
 *  with `padFrac` headroom above and below. Never collapses to zero height. */
export function fitRange(controls: number[], maxes: number[], target: number, padFrac = 0.08): Range {
  const vals = [...controls, ...maxes, target].filter((v) => Number.isFinite(v));
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : Number.isFinite(target) && target > 0 ? target : 1;
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * padFrac;
  return { lo: lo - pad, hi: hi + pad };
}

/** Map a value to a y pixel, inverted so `hi` sits at the top (y=0) and `lo` at the bottom (y=height). */
export function yOf(v: number, r: Range, height: number): number {
  return height - ((v - r.lo) / (r.hi - r.lo)) * height;
}

/** Map point index `i` of a `count`-point series to an x pixel across `width` (0 for a lone point). */
export function xOf(i: number, count: number, width: number): number {
  return count <= 1 ? 0 : (i / (count - 1)) * width;
}

/** SVG polyline `points` string for evenly-time-spaced `values`. */
export function polyline(values: number[], r: Range, width: number, height: number): string {
  return values
    .map((v, i) => `${xOf(i, values.length, width).toFixed(1)},${yOf(v, r, height).toFixed(1)}`)
    .join(" ");
}
