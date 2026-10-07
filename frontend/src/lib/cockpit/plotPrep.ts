// Pure preparation for the canvas timeline: break lines at link gaps, thin dense series to a few
// points per pixel without losing peaks, and keep a wild levels-off value off the axis. No DOM.

/** Index ranges [start, end) of runs of samples with no step longer than `maxGap` between them. */
export function gapSegments(ts: number[], maxGap: number): [number, number][] {
  const out: [number, number][] = [];
  let s = 0;
  for (let i = 1; i <= ts.length; i++) {
    if (i === ts.length || ts[i] - ts[i - 1] > maxGap) {
      if (i > s) out.push([s, i]);
      s = i;
    }
  }
  return out;
}

/**
 * Indices to draw for samples [s, e): all of them when there are at most 2 per pixel bucket;
 * otherwise, per bucket (of `buckets` across [t0, t0 + span]), the index of the minimum and of the
 * maximum, in index order, plus the first unknown (null) one so the line still breaks there.
 */
export function minMaxIndices(
  ts: number[],
  vs: (number | null)[],
  s: number,
  e: number,
  t0: number,
  span: number,
  buckets: number,
): number[] {
  if (e - s <= 2 * buckets || !(span > 0) || buckets < 1) return Array.from({ length: e - s }, (_, k) => s + k);
  const out: number[] = [];
  let cur = -1;
  let lo = -1, hi = -1, nul = -1;
  const flush = () => {
    const keep = [lo, hi, nul].filter((x) => x >= 0).sort((a, b) => a - b);
    for (const k of keep) if (out[out.length - 1] !== k) out.push(k);
    lo = hi = nul = -1;
  };
  for (let i = s; i < e; i++) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(((ts[i] - t0) / span) * buckets)));
    if (b !== cur) { if (cur >= 0) flush(); cur = b; }
    const v = vs[i];
    if (v == null || !Number.isFinite(v)) { if (nul < 0) nul = i; continue; }
    if (lo < 0 || v < (vs[lo] as number)) lo = i;
    if (hi < 0 || v > (vs[hi] as number)) hi = i;
  }
  if (cur >= 0) flush();
  return out;
}

/** Farther than this from the part (or, unknown part, the target) and a levels-off value is a bad fit. */
const PLATEAU_BAND_C = 100;

/** The levels-off value to put on the temperature axis, or null to leave it off (so a bad fit can't
 *  squash the lane). Judged against the part temperature, else the target; with neither, left off. */
export function plateauForAxis(plateau: number | null, partC: number | null, targetC: number | null): number | null {
  if (plateau == null || !Number.isFinite(plateau)) return null;
  const ref = partC != null && Number.isFinite(partC) ? partC : targetC != null && Number.isFinite(targetC) ? targetC : null;
  if (ref === null) return null;
  return Math.abs(plateau - ref) <= PLATEAU_BAND_C ? plateau : null;
}
