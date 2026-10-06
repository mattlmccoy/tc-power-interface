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

/** Why there is no control temperature, in words (null when the reading is fine). `status` comes
 *  from the operator's thermal block (`temp_status`); absent on operators older than v0.16. */
export function tempStatusText(status: string | undefined, roi: string | null | undefined): string | null {
  switch (status) {
    case "ok": return null;
    case "no_roi_selected": return "No control ROI selected — pick the part ROI below.";
    case "roi_not_in_feed": return `“${roi}” is not drawn in this FLIR session — pick a live ROI below.`;
    case "not_live": return "FLIR is not acquiring (no live camera frame).";
    case "no_feed": return "Can't reach FLIR — check the FLIR tool and the link URL.";
    case "roi_invalid": return "Control ROI is saturated or empty — no trustworthy temperature.";
    case "simulated": return "Simulated temperature — not the part. Switch the source to FLIR for real runs.";
    default: return "Temperature status unknown (older operator).";
  }
}
