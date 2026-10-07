// Browser-side persistence for the operator's settings forms, so limits / thermal plan can be
// configured while the operator is offline and synced to it when it becomes reachable. A save made
// offline is marked `pending`; the config loader pushes any pending value to the operator on the
// next successful connect, then clears the flag.

export const LIMITS_KEY = "tcp.limits.v1";
export const THERMAL_KEY = "tcp.thermal.v1";
export const COCKPIT_KEY = "tcp.cockpit.v1";
/** Fired on `window` after a same-tab save of COCKPIT_KEY (the `storage` event only reaches other tabs). */
export const COCKPIT_EVENT = "tcp-cockpit-changed";

export const COCKPIT_DEFAULTS = { tempC: 45, ratePerMin: 3 } as const;
export const COCKPIT_BOUNDS = { tempC: [25, 150], ratePerMin: [0.1, 30] } as const;

export interface Stored<T> {
  v: T;
  pending: boolean;
}

export function storeSettings<T>(storage: Storage | null, key: string, value: Stored<T>): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — keep in-memory only */
  }
}

export function loadSettings<T>(storage: Storage | null, key: string): Stored<T> | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored<T>;
    if (parsed && typeof parsed === "object" && "v" in parsed) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** The browser localStorage, or null when unavailable (private mode, SSR, blocked). */
export function settingsStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

const clamp = (x: number, [lo, hi]: readonly [number, number] | readonly number[]): number => Math.min(hi, Math.max(lo, x));
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Watched-core warn thresholds. Defaults (45 °C, 3 °C/min) are placeholders until set from run data —
 * the 09-24 runaway had no core ROI on camera — so the UI marks them provisional. A field that is
 * missing, NaN or not a number takes its default; a valid saved number is clamped to its bounds.
 * `provisional` stays true until at least one valid value has been saved by the operator.
 */
export function cockpitThresholds(v: { tempC?: number; ratePerMin?: number } | null): {
  tempC: number;
  ratePerMin: number;
  provisional: boolean;
} {
  const t = v && isNum(v.tempC) ? clamp(v.tempC, COCKPIT_BOUNDS.tempC) : null;
  const r = v && isNum(v.ratePerMin) ? clamp(v.ratePerMin, COCKPIT_BOUNDS.ratePerMin) : null;
  return {
    tempC: t ?? COCKPIT_DEFAULTS.tempC,
    ratePerMin: r ?? COCKPIT_DEFAULTS.ratePerMin,
    provisional: t === null && r === null,
  };
}

/** Save the operator's thresholds (per browser) and tell this tab's cockpit. */
export function saveCockpitThresholds(storage: Storage | null, v: { tempC: number; ratePerMin: number }): void {
  storeSettings(storage, COCKPIT_KEY, { v, pending: false });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COCKPIT_EVENT));
}
