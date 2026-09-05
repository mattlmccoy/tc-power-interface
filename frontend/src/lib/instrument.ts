// Pure helpers for the CXN-style instrument UI (analog gauges + status LEDs + cap steppers).

/** Map `value` in [min,max] to an angle in [startDeg,endDeg], clamped to the arc. */
export function gaugeAngle(
  value: number,
  min: number,
  max: number,
  startDeg: number,
  endDeg: number,
): number {
  const t = max === min ? 0 : (value - min) / (max - min);
  const clamped = Math.max(0, Math.min(1, t));
  return startDeg + clamped * (endDeg - startDeg);
}

/** Clamp a cap percentage to an integer in 0..100 (NaN -> 0). */
export function clampPercent(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export type LedTone = "ok" | "warn" | "off";
export interface Led {
  label: string;
  on: boolean;
  tone: LedTone;
}

// CXN status bit -> LED (label, tone when lit). Bits mirror STATUS_FLAGS in format.ts.
const LED_BITS: ReadonlyArray<readonly [number, string, "ok" | "warn"]> = [
  [1, "RF on", "ok"],
  [256, "Forward limit", "warn"],
  [512, "Reverse limit", "warn"],
  [1024, "Overheat", "warn"],
  [2048, "Interlock", "warn"],
];

/** Derive the status-LED strip (RF-on + limit/overheat/interlock) from the CXN status int. */
export function statusLeds(status: number): Led[] {
  return LED_BITS.map(([bit, label, tone]) => {
    const on = (status & bit) !== 0;
    return { label, on, tone: on ? tone : "off" };
  });
}
