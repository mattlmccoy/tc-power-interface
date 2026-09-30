// Live VNA sweep window. The match is judged AT 13.56 MHz, so 13.56 MHz must be an actual measured grid
// point — not a value interpolated between two neighbours. With the old 11-16 MHz / 401-point window
// 13.56 MHz fell between 13.5500 and 13.5625 MHz, and linear interpolation cut across the sharp bottom
// of the match loop: on the 218-2core_v2 network a true 41.6 dB match read as 36.6 dB
// (experiments/.../MANUAL_MATCHING_NETWORK/2026-09-30_COLD_MATCH_MAP_FEASIBILITY_ANALYSIS.md, §C).

export interface SweepWindow {
  start: number;
  stop: number;
  points: number;
}

/** A window of `points` grid points spaced `stepHz` apart, CENTRED on `f0`, so `f0` is exactly the
 *  middle point. `points` must be odd (an even count has no middle point). */
export function centredSweep(f0: number, stepHz: number, points: number): SweepWindow {
  if (!Number.isInteger(points) || points < 3 || points % 2 === 0) {
    throw new Error(`centredSweep needs an odd point count >= 3 (got ${points})`);
  }
  const half = ((points - 1) / 2) * stepHz;
  return { start: f0 - half, stop: f0 + half, points };
}

/** Distance (Hz) from `f0` to the nearest frequency the device actually returned, or null for an empty
 *  sweep. Logged with every sweep so a saved log shows whether the device's grid really contains
 *  13.56 MHz (0 Hz) — the firmware, not this code, decides the returned frequencies. */
export function f0GridOffsetHz(sweep: ReadonlyArray<{ frequency: number }>, f0: number): number | null {
  if (!sweep.length) return null;
  let best = Infinity;
  for (const p of sweep) best = Math.min(best, Math.abs(p.frequency - f0));
  return best;
}
