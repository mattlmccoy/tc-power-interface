export type WindowMode = "15" | "all";

/** Visible time range [from, to] in seconds: the last 15 min, or the whole buffer. Null if either end is unknown. */
export function timeWindow(tNow: number, mode: WindowMode, tFirst: number): [number, number] | null {
  if (!Number.isFinite(tNow) || !Number.isFinite(tFirst)) return null;
  return mode === "15" ? [Math.max(tFirst, tNow - 900), tNow] : [tFirst, tNow];
}

const STEPS = [60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400];

/**
 * Smallest tick interval (s) that keeps ticks at least `minPx` apart across `widthPx`: a whole
 * number of minutes, from STEPS or, past the last one, computed. A span under 60 s counts as 60 s.
 * Null when the span or width is not a positive finite number (nothing sensible to draw).
 */
export function tickStep(spanS: number, widthPx: number, minPx = 56): number | null {
  if (!(Number.isFinite(spanS) && spanS > 0 && Number.isFinite(widthPx) && widthPx > 0)) return null;
  const needed = (Math.max(spanS, 60) * minPx) / widthPx; // seconds per tick for minPx of space
  return STEPS.find((k) => k >= needed) ?? Math.ceil(needed / 60) * 60;
}

/** Temperature axis range: data and extras (targets, plateau) padded by 2 °C; unknowns ignored. */
export function tempRange(values: (number | null)[], extras: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of [...values, ...extras]) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo > hi) return [20, 30];
  return [Math.floor(lo - 2), Math.ceil(hi + 2)];
}

/** The "levels off at" line belongs to ladder and fixed runs only (to-temperature runs show a suggestion instead). */
export function showLevelsOffLine(mode: string, s: { show: boolean; plateau_c: number | null }): boolean {
  return (mode === "ladder" || mode === "fixed") && s.show && s.plateau_c != null && Number.isFinite(s.plateau_c);
}

/**
 * Gridline step for a value axis: the smallest 1-2-5 × 10^k step that keeps gridlines at least
 * `minPx` apart when `range` spans `px` pixels. Null when range or px is not positive and finite.
 */
export function axisStep(range: number, px: number, minPx = 18): number | null {
  if (!(Number.isFinite(range) && range > 0 && Number.isFinite(px) && px > 0)) return null;
  const needed = (range * minPx) / px;
  const k = Math.floor(Math.log10(needed));
  for (const e of [k, k + 1]) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** e;
      if (step >= needed - 1e-9) return e < 0 ? Number(step.toFixed(-e)) : step;
    }
  }
  return 10 ** (k + 2);
}
