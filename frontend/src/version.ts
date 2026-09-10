// Build identity, injected at build time by vite (`define`). APP_VERSION is the human-readable semver
// (source of truth: package.json "version", bumped per release); BUILD_ID is the git short SHA + date
// for exact traceability. Both are shown in the top bar and stamped into every saved VNA log, so a log
// tells you exactly which release/commit produced it. Fall back outside a vite build (e.g. `node --test`),
// where the globals are undefined — `typeof` on an undeclared identifier is safe and returns "undefined".
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

/** e.g. "v0.5.0" — the primary, human-readable version. */
export const VERSION_LABEL = `v${APP_VERSION}`;
/** Full identity for logs: "v0.5.0 · a1b2c3d · 2026-09-10 17:12". */
export const VERSION_FULL = `${VERSION_LABEL} · ${BUILD_ID}`;
