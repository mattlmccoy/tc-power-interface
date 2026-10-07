export type WindowMode = "15" | "all";

/** Visible time range [from, to] in seconds: the last 15 min, or the whole buffer. */
export function timeWindow(tNow: number, mode: WindowMode, tFirst: number): [number, number] {
  return mode === "15" ? [Math.max(tFirst, tNow - 900), tNow] : [tFirst, tNow];
}

const STEPS = [60, 120, 300, 600, 1200];

/** Smallest tick interval (s) that keeps ticks at least `minPx` apart across `widthPx`. */
export function tickStep(spanS: number, widthPx: number, minPx = 56): number {
  return STEPS.find((k) => (k / Math.max(spanS, 60)) * widthPx >= minPx) ?? STEPS[STEPS.length - 1];
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

export function showLevelsOffLine(mode: string, s: { show: boolean; plateau_c: number | null }): boolean {
  return mode !== "target" && s.show && s.plateau_c != null;
}
