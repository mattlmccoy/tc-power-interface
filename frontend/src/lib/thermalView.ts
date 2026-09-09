// Pure presentation helpers for the closed-loop hero. No DOM/React — unit-tested in thermalView.test.ts.

export type Phase = "ramp" | "approach" | "soak" | "cool" | "done";

/** The advance-only phase order (matches the backend ThermalPhase machine). */
export const PHASES: Phase[] = ["ramp", "approach", "soak", "cool", "done"];

/** Rank of a phase in the advance-only order, or -1 if unknown. */
export function phaseIndex(p: string): number {
  return PHASES.indexOf(p as Phase);
}

/** Applied-power label: `null` means advisory (the loop recommends but does not drive). */
export function appliedLabel(applied: number | null): string {
  return applied === null ? "advisory" : `${Math.round(applied)} W`;
}

/** Over-temp guard presentation. Absence is NEVER shown as healthy — `not-reported` is distinct
 *  from a real value so the hero can't imply a safe reading it does not have. */
export type GuardState = { kind: "value"; maxC: number } | { kind: "not-reported" };

export function overTempGuard(maxC: number | null | undefined): GuardState {
  return maxC == null ? { kind: "not-reported" } : { kind: "value", maxC };
}
