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

/** Clamp a cap percentage to a WHOLE percent in 0..100 (the AG 0613 commands caps in 1% steps,
 *  verified on hardware 2026-09-07; NaN -> 0). */
export function clampCap(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
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

/** Two whole-percent steps to land a cap on ``target`` from BELOW — cancels the AIT's mechanical
 *  backlash and matches the increasing-% direction the calibration was swept in: overshoot to
 *  ``target - margin`` (clamped >= 0), then finish going UP to target. Returns [pre, target]. */
export function approachFromBelow(target: number, margin = 3): [number, number] {
  const t = clampCap(target);
  return [Math.max(0, t - Math.max(1, Math.round(margin))), t];
}

/** True when the device's cap readback has reached ``target`` within ``tol`` whole percent (inclusive).
 *  A null/NaN readback (no telemetry yet) is never "settled". Used to wait out the SLOW AIT motor
 *  between the two steps of a backlash-compensated approach so the final move is genuinely upward. */
export function capSettled(read: number | null, target: number, tol = 2): boolean {
  if (read == null || Number.isNaN(read)) return false;
  return Math.abs(read - target) <= tol;
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

/** Nudge a forward-power setpoint by ``delta`` watts and clamp to [0, ``max``], rounded to whole
 *  watts (the generator commands integer watts). A NaN/empty ``current`` starts from 0; a non-finite
 *  ``max`` (e.g. the limit hasn't loaded) applies no upper clamp. Used by the live −/+ power steppers
 *  and keyboard ↑/↓, which send instantly with no Apply. The server clamps again as the real guard. */
export function stepSetpoint(current: number, delta: number, max: number): number {
  const base = Number.isNaN(current) ? 0 : current;
  const hi = Number.isFinite(max) ? max : Infinity;
  return Math.max(0, Math.min(hi, Math.round(base + delta)));
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
