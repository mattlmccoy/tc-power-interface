/** The temperature loop's Engage gates (spec §4, D12). In v0.17 the interlock gate is always false
 *  (backend `thermal.engage.available` is false), so Engage stays locked; the backend also answers 409. */
export interface GateInput {
  runMode: string;
  controlRoi: string | null;
  /** `thermal.temp_status`. Only "ok" passes (backend flir_roi_temps.py `control_status`: ok,
   *  no_roi_selected, not_live, roi_not_in_feed, roi_invalid, plus "no_feed" before the first poll).
   *  Anything else, including undefined or a simulated feed, fails: conservative on purpose. */
  tempStatus: string | undefined;
  replay: boolean;
  confidence: number;
  /** Number of `thermal.watch` entries whose status is "ok" (backend core_watch.py: "ok",
   *  "not_in_feed", "invalid"). Watched-but-dark cores must not count as watched. */
  liveWatchCount: number;
  interlockArmed: boolean;
  /** `thermal.engage.reason`, shown while the interlock is not armed. */
  interlockReason?: string | null;
}
export interface Gate {
  ok: boolean;
  text: string;
}

export const ENGAGE_CONFIDENCE = 0.6;
const DEFAULT_INTERLOCK_TEXT = "Core interlock (not built yet)";

export function loopGates(i: GateInput): Gate[] {
  const conf = Number.isFinite(i.confidence) ? `${Math.round(i.confidence * 100)} %` : "—";
  const liveCores = Number.isFinite(i.liveWatchCount) ? i.liveWatchCount : 0;
  return [
    { ok: i.runMode === "target", text: "To-temperature mode" },
    { ok: !i.replay && !!i.controlRoi && i.tempStatus === "ok", text: `${i.controlRoi || "Control ROI"} live (stale → 0 W)` },
    { ok: i.confidence >= ENGAGE_CONFIDENCE, text: `Confidence ${conf} (needs ≥ ${Math.round(ENGAGE_CONFIDENCE * 100)})` },
    { ok: liveCores > 0, text: `Cores live (${liveCores})` },
    { ok: i.interlockArmed, text: i.interlockArmed ? "Core interlock armed" : i.interlockReason || DEFAULT_INTERLOCK_TEXT },
  ];
}

export function engageAllowed(gates: Gate[]): boolean {
  return gates.every((g) => g.ok);
}
