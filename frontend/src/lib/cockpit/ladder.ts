/** Power-ladder numbers from free text: positive, unique, ascending. A leading minus rejects
 *  that number ("-3" is dropped, not read as 3); malformed tokens like "1.5.5" are skipped. */
export function parseLadder(text: string): number[] {
  const tokens = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const nums = tokens.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** Which ladder step the forward power has reached (1-based; 0 = below the first) and the next one. */
export function ladderStep(steps: number[], fwd: number): { index: number; next: number | null } {
  const index = steps.filter((w) => fwd >= w - 1).length;
  return { index, next: steps[index] ?? null };
}

/** Where the part would level off at `watts`, from a valid first-order estimate; null otherwise. */
export function nextPlateau(
  e: { valid: boolean; k_c_per_w: number | null; t_amb_c: number | null },
  watts: number,
): number | null {
  return e.valid && e.k_c_per_w != null && e.t_amb_c != null ? e.t_amb_c + e.k_c_per_w * watts : null;
}

export type CoreLevel = "ok" | "warn" | "unknown";

/** Core (transformer) watch level: warn on temperature or rate of rise; no/invalid temperature is unknown. */
export function coreLevel(
  tempC: number | null,
  ratePerMin: number | null,
  th: { tempC: number; ratePerMin: number },
): CoreLevel {
  if (tempC == null || !Number.isFinite(tempC)) return "unknown";
  return tempC >= th.tempC || (ratePerMin ?? 0) >= th.ratePerMin ? "warn" : "ok";
}
