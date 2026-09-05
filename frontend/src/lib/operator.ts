// Where the operator (local Python `tcp-serve`) lives.
//
// Served by the operator itself: same origin, base "". Served from GitHub Pages (site mode):
// http://localhost:8000 by default, overridable and persisted in localStorage. Mirrors FLIR.

export const DEFAULT_SITE_BASE = "http://localhost:8000";
const KEY = "tcp.operator.v1";

/** "" for same-origin, an http(s) origin without trailing slash, or null when invalid. */
export function normalizeBase(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  if (s === "") return "";
  return /^https?:\/\/[^\s/]+$/i.test(s) ? s : null;
}

export function loadOperatorBase(storage: Storage | null, opts: { siteMode: boolean }): string {
  const fallback = opts.siteMode ? DEFAULT_SITE_BASE : "";
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return fallback;
    const n = normalizeBase(raw);
    return n === null ? fallback : n;
  } catch {
    return fallback;
  }
}

export function saveOperatorBase(storage: Storage | null, base: string): void {
  const n = normalizeBase(base);
  if (n === null) return;
  try {
    storage?.setItem(KEY, n);
  } catch {
    /* ignore */
  }
}

export function apiUrl(base: string, path: string): string {
  return `${base}${path}`;
}

export function wsUrl(base: string, path: string, loc?: { protocol: string; host: string }): string {
  if (base === "") {
    const l = loc ?? globalThis.location;
    return `${l.protocol === "https:" ? "wss" : "ws"}://${l.host}${path}`;
  }
  return `${base.replace(/^http/i, "ws")}${path}`;
}
