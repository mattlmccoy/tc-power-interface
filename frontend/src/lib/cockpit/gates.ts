/** The temperature loop's Engage gates (spec §4, D12). In v0.17 the interlock gate is always false
 *  (backend `thermal.engage.available` is false), so Engage stays locked; the backend also answers 409. */
export interface GateInput {
  runMode: string;
  controlRoi: string | null;
  tempStatus: string | undefined;
  replay: boolean;
  confidence: number;
  watchCount: number;
  interlockArmed: boolean;
}
export interface Gate {
  ok: boolean;
  text: string;
}

export const ENGAGE_CONFIDENCE = 0.6;

export function loopGates(i: GateInput): Gate[] {
  const conf = Number.isFinite(i.confidence) ? `${Math.round(i.confidence * 100)} %` : "—";
  return [
    { ok: i.runMode === "target", text: "To-temperature mode" },
    { ok: !i.replay && !!i.controlRoi && i.tempStatus === "ok", text: `${i.controlRoi ?? "No control ROI"} live (stale → 0 W)` },
    { ok: i.confidence >= ENGAGE_CONFIDENCE, text: `Confidence ${conf} (needs ≥ ${Math.round(ENGAGE_CONFIDENCE * 100)})` },
    { ok: i.watchCount > 0, text: `Cores watched (${i.watchCount})` },
    { ok: i.interlockArmed, text: i.interlockArmed ? "Core interlock armed" : "Core interlock (not built yet)" },
  ];
}

export function engageAllowed(gates: Gate[]): boolean {
  return gates.every((g) => g.ok);
}
