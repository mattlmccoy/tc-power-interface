// Thin REST client for the operator. In site mode (served from GitHub Pages) it targets a local
// operator base (default http://localhost:8000) and every write carries X-TCP-Client so the
// operator's cross-origin guard passes. State-changing calls return the raw Response so the caller
// can surface the server's error detail (e.g. a 409 when RF-enable is refused while faulted).

import type { FlirLinkResult } from "./format.ts";
import { apiUrl, loadOperatorBase, saveOperatorBase } from "./operator.ts";
import type { SafetyLimitsForm, SafetyLimitsStatus, Status } from "./telemetry.ts";

/** Shape of GET/POST /api/flir-link — the operator's link to the separate FLIR tool. */
export interface FlirLink {
  url: string;
  enabled: boolean;
  last_result: FlirLinkResult;
}

/** Site mode: the UI is served from GitHub Pages and talks to a local operator. */
export const SITE_MODE = import.meta.env.VITE_SITE_MODE === "1";

const storage: Storage | null = (() => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
})();

let BASE = loadOperatorBase(storage, { siteMode: SITE_MODE });
export function operatorBase(): string {
  return BASE;
}
export function setOperatorBase(base: string): void {
  saveOperatorBase(storage, base);
  BASE = loadOperatorBase(storage, { siteMode: SITE_MODE });
}

async function post(path: string, body?: unknown): Promise<Response> {
  const headers = new Headers(body !== undefined ? { "Content-Type": "application/json" } : {});
  headers.set("X-TCP-Client", "1");
  return fetch(apiUrl(BASE, path), {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function detail(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return typeof j.detail === "string" ? j.detail : JSON.stringify(j);
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const api = {
  status: async (): Promise<Status> => (await fetch(apiUrl(BASE, "/api/status"))).json(),
  setSetpoint: (watts: number) => post("/api/setpoint", { watts }),
  rfEnable: () => post("/api/rf/enable"),
  rfDisable: () => post("/api/rf/disable"),
  manual: (on: boolean) => post("/api/match/manual", { on }),
  tune: (percent: number) => post("/api/match/tune", { percent }),
  load: (percent: number) => post("/api/match/load", { percent }),
  startRecording: (name: string, notes: string) =>
    post("/api/recording/start", { name, notes }),
  stopRecording: () => post("/api/recording/stop"),
  flirLink: async (): Promise<FlirLink> => (await fetch(apiUrl(BASE, "/api/flir-link"))).json(),
  setFlirLink: (url: string, enabled: boolean) => post("/api/flir-link", { url, enabled }),
  safetyLimits: async (): Promise<SafetyLimitsStatus> =>
    (await fetch(apiUrl(BASE, "/api/safety-limits"))).json(),
  saveSafetyLimits: (v: SafetyLimitsForm) => post("/api/safety-limits", v),
};
