// Build identity, injected at build time by vite (`define: __BUILD_ID__`) from the git short SHA + date.
// Shown in the top bar and stamped into every saved VNA log, so a log tells you exactly which build
// produced it. Falls back to "dev" outside a vite build (e.g. under `node --test`), where the global is
// undefined — `typeof` on an undeclared identifier is safe and returns "undefined".
declare const __BUILD_ID__: string | undefined;

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
