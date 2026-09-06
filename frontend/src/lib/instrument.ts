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

/** Clamp a cap percentage to 0..100 at 0.1% resolution (the CXN tuner's granularity; NaN -> 0). */
export function clampCap(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

// Physical AIT-600 cap control-voltage ranges (~0-5 V). The generator reports position as 0-100%;
// these map % -> the control voltage the operator reads on the tuner. Validated against the
// 2026-09-04 bench match (S1P title T1.85/L2.46 measured at generator TC=36%, LC=49%).
export const TUNE_VOLTS: [number, number] = [0.12, 4.92];
export const LOAD_VOLTS: [number, number] = [0.11, 4.93];

/** Map a cap percentage (0-100) to its control voltage, linearly across ``range`` (clamped). */
export function capVolts(percent: number, range: [number, number]): number {
  const [lo, hi] = range;
  const p = Math.max(0, Math.min(100, percent));
  return lo + (p / 100) * (hi - lo);
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
