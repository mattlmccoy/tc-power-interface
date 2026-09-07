// Where the operator (local Python `tcp-serve`) lives.
//
// Served by the operator itself: same origin, base "". Served from GitHub Pages (site mode):
// http://localhost:8000 by default, overridable and persisted in localStorage. Mirrors FLIR.

export const DEFAULT_SITE_BASE = "http://localhost:8010";
const KEY = "tcp.operator.v1";

/** This UI build's version, and the operator API version it speaks (major.minor). The operator
 *  reports its own at /api/health; checkHandshake compares them (mirrors the FLIR tool). */
export const UI_VERSION = "0.2.0";
export const UI_API_VERSION = "0.1";

export type Handshake = { level: "ok" } | { level: "warn" | "refuse"; message: string };

/** Compare the UI's API version with the operator's: a MAJOR mismatch refuses (incompatible — the
 *  UI or operator is stale and must be updated), a MINOR mismatch warns, otherwise ok. */
export function checkHandshake(ui: string, operator: string | undefined): Handshake {
  if (!operator)
    return { level: "refuse", message: "operator did not report an API version; update the operator" };
  const [um, un] = ui.split(".").map(Number);
  const [om, on] = operator.split(".").map(Number);
  if (um !== om)
    return {
      level: "refuse",
      message: `operator API ${operator} is incompatible with this UI (${ui}) — reload the page, and update the operator if it persists`,
    };
  if (un !== on)
    return {
      level: "warn",
      message: `operator API ${operator} differs from this UI (${ui}); some features may be missing — reload the page`,
    };
  return { level: "ok" };
}

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
