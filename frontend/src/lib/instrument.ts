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

/** Temperature progress from room->max (e.g. the over-temp trip), with a green->red hue.
 *  fraction 0 = green (hsl 120), fraction 1 = red (hsl 0), clamped to [0,1]. */
export function tempBar(
  tempC: number,
  roomC: number,
  maxC: number,
): { fraction: number; color: string } {
  const denom = maxC - roomC;
  const raw = denom <= 0 ? 0 : (tempC - roomC) / denom;
  const fraction = Math.max(0, Math.min(1, raw));
  const hue = Math.round(120 * (1 - fraction));
  return { fraction, color: `hsl(${hue}, 65%, 45%)` };
}

/** RF-source (internal/external) + leveling (forward/load) read from the CXN status bits. */
export function generatorModes(status: number): {
  rfSource: "internal" | "external";
  leveling: "forward" | "load";
} {
  return {
    rfSource: (status & 16) !== 0 ? "external" : "internal", // EXTERNAL_RFSOURCE
    leveling: (status & 32) !== 0 ? "load" : "forward", // LOAD_POWER_LEVELING
  };
}
