import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Human-readable app version — the single source of truth is package.json "version" (bump it per release).
const APP_VERSION: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// Build identity: git short SHA (+ "*" if the tree is dirty) and the build date. Injected as __BUILD_ID__
// so the running app and every saved log can report exactly which build they are. Built in the served
// checkout, so the SHA is the deployed commit.
function buildId(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    // Only flag uncommitted *tracked* edits (-uno) — the untracked build output (dist/) is not "dirty".
    const dirty = execSync("git status --porcelain -uno").toString().trim() ? "*" : "";
    const date = new Date().toISOString().slice(0, 16).replace("T", " ");
    return `${sha}${dirty} · ${date}`;
  } catch {
    return "unknown";
  }
}

// Dev server proxies API + WebSocket to the Python operator on :8010 (T&C's default; 8000 is FLIR).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: { __BUILD_ID__: JSON.stringify(buildId()), __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8010",
      "/ws": { target: "ws://127.0.0.1:8010", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
