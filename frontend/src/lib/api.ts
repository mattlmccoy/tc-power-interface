// Thin REST client for the operator. In site mode (served from GitHub Pages) it targets a local
// operator base (default http://localhost:8000) and every write carries X-TCP-Client so the
// operator's cross-origin guard passes. State-changing calls return the raw Response so the caller
// can surface the server's error detail (e.g. a 409 when RF-enable is refused while faulted).

import type { FlirLinkResult } from "./format.ts";
import { apiUrl, loadOperatorBase, saveOperatorBase } from "./operator.ts";
import type {
  MatchTunerConfig,
  MatchTunerForm,
  RampConfig,
  RampForm,
  SafetyLimitsForm,
  SafetyLimitsStatus,
  Status,
  PulseConfig,
  ThermalPlanForm,
  ThermalPlanStatus,
  TimerConfig,
} from "./telemetry.ts";

/** Shape of GET/POST /api/flir-link — the operator's link to the separate FLIR tool. */
export interface FlirLink {
  url: string;
  enabled: boolean;
  last_result: FlirLinkResult;
}

/** A serial port the operator can connect to (from GET /api/discovery). */
export interface SerialPort {
  device: string;
  description: string;
  hwid: string;
}

/** GET /api/discovery — available ports plus the current connection (null when idle). */
export interface Discovery {
  ports: SerialPort[];
  connected: { backend: string; port: string | null } | null;
}

/** GET /api/health — the operator's app version and the API version it speaks. */
export interface Health {
  version: string;
  /** The frontend release version the operator was deployed with (drives the update banner). */
  app_version?: string | null;
  /** The release the running backend process was started with (app_version is re-read from disk). */
  running_app_version?: string | null;
  api_version?: string;
  backend?: string;
  platform?: string;
}

/** Site mode: the UI is served from GitHub Pages and talks to a local operator. */
export const SITE_MODE = import.meta.env?.VITE_SITE_MODE === "1";

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

function send(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Response> {
  const headers = new Headers(body !== undefined ? { "Content-Type": "application/json" } : {});
  headers.set("X-TCP-Client", "1");
  return fetch(apiUrl(BASE, path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function post(path: string, body?: unknown): Promise<Response> {
  return send("POST", path, body);
}

function put(path: string, body?: unknown): Promise<Response> {
  return send("PUT", path, body);
}

function del(path: string): Promise<Response> {
  return send("DELETE", path);
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
  health: async (): Promise<Health> => (await fetch(apiUrl(BASE, "/api/health"))).json(),
  discovery: async (): Promise<Discovery> => (await fetch(apiUrl(BASE, "/api/discovery"))).json(),
  connect: (backend: string, serial?: string) => post("/api/connect", { backend, serial }),
  disconnect: () => post("/api/disconnect"),
  arm: () => post("/api/arm"),
  disarm: () => post("/api/disarm"),
  setSetpoint: (watts: number) => post("/api/setpoint", { watts }),
  rfEnable: () => post("/api/rf/enable"),
  rfDisable: () => post("/api/rf/disable"),
  estop: () => post("/api/estop"),
  clearFault: () => post("/api/clear-fault"),
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
  saveSafetyLimits: (v: SafetyLimitsForm) => put("/api/safety-limits", v),
  thermalPlan: async (): Promise<ThermalPlanStatus> =>
    (await fetch(apiUrl(BASE, "/api/thermal/plan"))).json(),
  saveThermalPlan: (v: ThermalPlanForm) => put("/api/thermal/plan", v),
  thermalStart: (mode: string) => post("/api/thermal/start", { mode }),
  thermalStop: () => post("/api/thermal/stop"),
  thermalArm: () => post("/api/thermal/arm"),
  thermalDisarm: () => post("/api/thermal/disarm"),
  thermalSource: (type: string, url?: string) => post("/api/thermal/source", { type, url }),
  setThermalRoi: (name: string) => post("/api/thermal/roi", { name }),
  ramp: async (): Promise<RampConfig> => (await fetch(apiUrl(BASE, "/api/ramp"))).json(),
  saveRamp: (v: RampForm) => put("/api/ramp", v),
  rampStart: () => post("/api/ramp/start"),
  rampStop: () => post("/api/ramp/stop"),
  /** Raw Response so the caller can show the 503 "VISA unavailable" detail. */
  scopeResources: (): Promise<Response> => fetch(apiUrl(BASE, "/api/scope/resources")),
  scopeSettings: (body: Record<string, unknown>) => post("/api/scope/settings", body),
  scopeConnect: () => post("/api/scope/connect"),
  scopeDisconnect: () => post("/api/scope/disconnect"),
  timer: async (): Promise<TimerConfig> => (await fetch(apiUrl(BASE, "/api/timer"))).json(),
  saveTimer: (minutes: number) => put("/api/timer", { minutes }),
  timerStart: () => post("/api/timer/start"),
  timerStop: () => post("/api/timer/stop"),
  presetSave: (slot: number, tune: number, load: number) =>
    put(`/api/presets/${slot}`, { tune, load }),
  presetRecall: (slot: number) => post(`/api/presets/${slot}/recall`),
  presetDelete: (slot: number) => del(`/api/presets/${slot}`),
  pulse: async (): Promise<PulseConfig> => (await fetch(apiUrl(BASE, "/api/pulse"))).json(),
  savePulse: (on_ms: number, off_ms: number, power_w: number) =>
    put("/api/pulse", { on_ms, off_ms, power_w }),
  pulseStart: () => post("/api/pulse/start"),
  pulseStop: () => post("/api/pulse/stop"),
  matchTuner: async (): Promise<MatchTunerConfig> =>
    (await fetch(apiUrl(BASE, "/api/match-tuner"))).json(),
  saveMatchTuner: (v: MatchTunerForm) => put("/api/match-tuner", v),
  matchTunerStart: () => post("/api/match-tuner/start"),
  matchTunerStop: () => post("/api/match-tuner/stop"),
  matchTunerArm: () => post("/api/match-tuner/arm"),
  matchTunerDisarm: () => post("/api/match-tuner/disarm"),
  // VNA pre-run auto-tune session (RF-off interlock). Begin refuses RF until End; heartbeat keeps
  // the session liveness fresh so a dead tab surfaces as `vna_session.stale` in the status.
  vnaBegin: () => post("/api/vna-session/begin"),
  vnaEnd: () => post("/api/vna-session/end"),
  vnaHeartbeat: () => post("/api/vna-session/heartbeat"),
  autoLog: async (): Promise<{ enabled: boolean }> =>
    (await fetch(apiUrl(BASE, "/api/auto-log"))).json(),
  setAutoLog: (enabled: boolean) => put("/api/auto-log", { enabled }),
  /** Fetch a run's telemetry.csv and trigger a browser download. Throws with the server detail. */
  downloadRecording: (run: string): Promise<void> =>
    saveDownload(`/api/recordings/${encodeURIComponent(run)}/telemetry.csv`, `${run}_telemetry.csv`),
  /** Download one whitelisted run file (GET /api/recordings/{run}/files/{path}). */
  downloadRecordingFile: (run: string, path: string): Promise<void> =>
    saveDownload(
      `/api/recordings/${encodeURIComponent(run)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
      `${run}_${path.replaceAll("/", "_")}`,
    ),
  /** A run's downloadable file names; null when the run or the endpoint is missing (older backend). */
  recordingFiles: async (run: string): Promise<string[] | null> => {
    try {
      const res = await fetch(apiUrl(BASE, `/api/recordings/${encodeURIComponent(run)}/files`));
      if (!res.ok) return null;
      const body = (await res.json()) as { files?: unknown };
      return Array.isArray(body.files) ? body.files.map(String) : null;
    } catch {
      return null;
    }
  },
  /** GET /api/recordings runs ({run, path?}); null on failure. */
  listRecordings: async (): Promise<{ run: string; path?: string }[] | null> => {
    try {
      const res = await fetch(apiUrl(BASE, "/api/recordings"));
      if (!res.ok) return null;
      const body = (await res.json()) as { runs?: { run: string; path?: string }[] };
      return Array.isArray(body.runs) ? body.runs : null;
    } catch {
      return null;
    }
  },
  /** Open the run folder in the OS file browser (POST, so it carries X-TCP-Client). */
  revealRecording: (run: string) => post(`/api/recordings/${encodeURIComponent(run)}/reveal`),
};

async function saveDownload(path: string, filename: string): Promise<void> {
  const res = await fetch(apiUrl(BASE, path));
  if (!res.ok) throw new Error(await detail(res));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
