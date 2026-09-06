// Browser-side persistence for the operator's settings forms, so limits / thermal plan can be
// configured while the operator is offline and synced to it when it becomes reachable. A save made
// offline is marked `pending`; the config loader pushes any pending value to the operator on the
// next successful connect, then clears the flag.

export const LIMITS_KEY = "tcp.limits.v1";
export const THERMAL_KEY = "tcp.thermal.v1";

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
