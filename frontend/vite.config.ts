import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Build identity: git short SHA (+ "*" if the tree is dirty) and the build date. Injected as __BUILD_ID__
// so the running app and every saved log can report exactly which build they are. Built in the served
// checkout, so the SHA is the deployed commit.
function buildId(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const dirty = execSync("git status --porcelain").toString().trim() ? "*" : "";
    const date = new Date().toISOString().slice(0, 16).replace("T", " ");
    return `${sha}${dirty} · ${date}`;
  } catch {
    return "unknown";
  }
}

// Dev server proxies API + WebSocket to the Python operator on :8010 (T&C's default; 8000 is FLIR).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
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
