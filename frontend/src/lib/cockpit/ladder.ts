export interface LadderParse {
  steps: number[];
  /** Tokens that were not read as a power, verbatim, so the UI can say "ignored: 1.5.5". */
  rejected: string[];
}

const NUMBER_TOKEN = /^(\d+(\.\d+)?|\.\d+)$/; // 5, 7.5, 0.5, .5

/**
 * Power-ladder steps from free text: positive, unique, ascending. Tokens are split on whitespace,
 * commas and semicolons (so "1,5" is TWO steps, 1 W and 5 W; there is no decimal comma). A token
 * must be a whole plain number: "-3", "5-3", "1.5.5", "1e3" and "0" are rejected whole, never
 * partly salvaged.
 */
export function parseLadder(text: string): LadderParse {
  const steps = new Set<number>();
  const rejected: string[] = [];
  for (const tok of text.split(/[\s,;]+/)) {
    if (!tok) continue;
    const n = NUMBER_TOKEN.test(tok) ? Number(tok) : Number.NaN;
    if (Number.isFinite(n) && n > 0) steps.add(n);
    else rejected.push(tok);
  }
  return { steps: [...steps].sort((a, b) => a - b), rejected };
}

/** Within 2 % of a step (at least 0.1 W) counts as being on it: the generator's forward power wobbles. */
function stepTolerance(w: number): number {
  return Math.max(0.1, 0.02 * w);
}

/**
 * Which ladder step the forward power has reached (1-based; 0 = below the first) and the next one.
 * An unknown (non-finite) forward power is `index: null`, never 0.
 */
export function ladderStep(steps: number[], fwd: number): { index: number | null; next: number | null } {
  if (!Number.isFinite(fwd)) return { index: null, next: null };
  const index = steps.filter((w) => fwd >= w - stepTolerance(w)).length;
  return { index, next: steps[index] ?? null };
}

/** Where the part would level off at `watts`, from a valid first-order estimate; null if anything is unknown. */
export function nextPlateau(
  e: { valid: boolean; k_c_per_w: number | null; t_amb_c: number | null },
  watts: number,
): number | null {
  if (!e.valid || e.k_c_per_w == null || e.t_amb_c == null) return null;
  const p = e.t_amb_c + e.k_c_per_w * watts;
  return Number.isFinite(p) ? p : null;
}

export type CoreLevel = "ok" | "warn" | "unknown";

/**
 * Core (transformer) watch level. The backend sends `rate_c_per_min: null` for the first 60 s and
 * after any invalid sample, so a missing rate must not read as "ok" (a warm core would look green):
 *  - non-finite thresholds or temperature -> unknown
 *  - temperature at/over its threshold -> warn, whatever the rate
 *  - rate at/over its threshold -> warn
 *  - temperature below, rate missing -> unknown
 *  - both below -> ok
 */
export function coreLevel(
  tempC: number | null,
  ratePerMin: number | null,
  th: { tempC: number; ratePerMin: number },
): CoreLevel {
  if (!Number.isFinite(th.tempC) || !Number.isFinite(th.ratePerMin)) return "unknown";
  if (tempC == null || !Number.isFinite(tempC)) return "unknown";
  if (tempC >= th.tempC) return "warn";
  if (ratePerMin == null || !Number.isFinite(ratePerMin)) return "unknown";
  return ratePerMin >= th.ratePerMin ? "warn" : "ok";
}
