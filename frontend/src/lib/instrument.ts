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

// Measured AIT-600 cap %->V transfer curves (2026-09-07 rematch bench data; see
// experiments/.../2026-09-07_rematch/cap_percent_voltage_calibration.csv). The generator reports/
// commands cap position in whole percent, but the manual VNA tuning is done in VOLTS, so we work in
// volts via these curves. The curve is ~linear mid-range and flattens at both ends, so a 2-point
// line is wrong there — interpolate piecewise. Monotonic increasing (needed for the inverse).
export type CapCal = ReadonlyArray<readonly [number, number]>; // [percent, volts], ascending
export const TUNE_CAL: CapCal = [
  [0, 0.12], [1, 0.18], [2, 0.22], [3, 0.27], [4, 0.32], [5, 0.36], [6, 0.41], [7, 0.46], [8, 0.51],
  [9, 0.55], [10, 0.6], [15, 0.84], [20, 1.07], [25, 1.32], [30, 1.55], [35, 1.79], [40, 2.03],
  [45, 2.26], [50, 2.5], [55, 2.77], [60, 2.98], [65, 3.22], [70, 3.45], [75, 3.69], [80, 3.93],
  [85, 4.17], [90, 4.41], [95, 4.65], [96, 4.69], [97, 4.74], [98, 4.79], [99, 4.84], [100, 4.89],
];
export const LOAD_CAL: CapCal = [
  [0, 0.14], [1, 0.18], [2, 0.23], [3, 0.27], [4, 0.32], [5, 0.37], [6, 0.42], [7, 0.46], [8, 0.51],
  [9, 0.56], [10, 0.6], [15, 0.86], [20, 1.08], [25, 1.32], [30, 1.56], [35, 1.8], [40, 2.04],
  [45, 2.28], [50, 2.51], [55, 2.77], [60, 2.99], [65, 3.23], [70, 3.47], [75, 3.71], [80, 3.95],
  [85, 4.19], [90, 4.43], [95, 4.67], [96, 4.72], [97, 4.77], [98, 4.81], [99, 4.86], [100, 4.91],
];

/** Interpolate a cap percentage (0-100) to its control voltage along the measured curve (clamped). */
export function capVolts(percent: number, cal: CapCal): number {
  const lo = cal[0];
  const hi = cal[cal.length - 1];
  const p = Math.max(lo[0], Math.min(percent, hi[0]));
  for (let i = 1; i < cal.length; i++) {
    if (p <= cal[i][0]) {
      const [x0, y0] = cal[i - 1];
      const [x1, y1] = cal[i];
      const f = x1 === x0 ? 0 : (p - x0) / (x1 - x0);
      return y0 + f * (y1 - y0);
    }
  }
  return hi[1];
}

/** Inverse: the whole percent whose control voltage is nearest ``volts`` (the generator commands in
 *  1% steps, so we round; clamped to the curve's voltage range). For voltage-driven cap tuning. */
export function capPercentForVolts(volts: number, cal: CapCal): number {
  const lo = cal[0];
  const hi = cal[cal.length - 1];
  const v = Math.max(lo[1], Math.min(volts, hi[1]));
  for (let i = 1; i < cal.length; i++) {
    if (v <= cal[i][1]) {
      const [x0, y0] = cal[i - 1];
      const [x1, y1] = cal[i];
      const f = y1 === y0 ? 0 : (v - y0) / (y1 - y0);
      return Math.round(x0 + f * (x1 - x0));
    }
  }
  return hi[0];
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
