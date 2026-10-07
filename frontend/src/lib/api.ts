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
  RunMode,
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

/** One run in GET /api/recordings (backend api/app.py list_recordings). */
export interface RecordingRun {
  run: string;
  /** false = no manifest.json: still recording, or crashed. */
  complete: boolean;
  size_bytes: number;
  has_roi_data: boolean;
}

/** One entry of a run's events.json (written by the recorder on a clean stop). */
export interface RecordingEvent {
  host_timestamp_ns: number;
  label: string;
  data: Record<string, unknown>;
}

/** One replayed shadow-loop point (backend recording/replay_shadow.py); null = no estimate yet. */
export interface ReplayShadowPoint {
  t_s: number;
  temp_c: number | null;
  k_c_per_w: number | null;
  tau_s: number | null;
  confidence: number;
  suggest_w: number | null;
  plateau_c: number | null;
}

/** GET /api/recordings/{run}/shadow. */
export interface ReplayShadow {
  roi: string;
  target_c: number;
  points: ReplayShadowPoint[];
}

/** Path of the shadow replay for a run on one ROI. A non-finite target (or ceiling) throws: it
 * would otherwise serialize as "target=NaN" and come back as a confusing 422. */
export const replayShadowPath = (run: string, roi: string, target: number, ceiling?: number): string => {
  if (!Number.isFinite(target)) throw new Error(`replay target must be a finite number, got ${target}`);
  if (ceiling !== undefined && !Number.isFinite(ceiling))
    throw new Error(`replay ceiling must be a finite number, got ${ceiling}`);
  const q = `roi=${encodeURIComponent(roi)}&target=${target}${ceiling === undefined ? "" : `&ceiling=${ceiling}`}`;
  return `/api/recordings/${encodeURIComponent(run)}/shadow?${q}`;
};

/** GET `path`; on a non-2xx throws an Error carrying the server's detail. */
async function getOk(path: string): Promise<Response> {
  const res = await fetch(apiUrl(BASE, path));
  if (!res.ok) throw new Error(await detail(res));
  return res;
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
  // Cockpit: core-watch ROIs, run mode (bookkeeping only), the always-locked engage, and replay.
  setWatch: (names: string[]) => post("/api/thermal/watch", { names }),
  setRunMode: (m: RunMode) => post("/api/run-mode", m),
  /** Refused with 409 until the core interlock exists (v0.18); the UI shows the reason. */
  engageLoop: () => post("/api/thermal/engage"),
  recordings: async (): Promise<RecordingRun[]> =>
    ((await (await getOk("/api/recordings")).json()) as { runs: RecordingRun[] }).runs,
  recordingCsv: async (run: string): Promise<string> =>
    (await getOk(`/api/recordings/${encodeURIComponent(run)}/telemetry.csv`)).text(),
  recordingRois: async (run: string): Promise<string[]> =>
    ((await (await getOk(`/api/recordings/${encodeURIComponent(run)}/rois`)).json()) as { rois: string[] }).rois,
  /** 404 for a run that never stopped cleanly (events.json is written on a clean stop only). */
  recordingEvents: async (run: string): Promise<RecordingEvent[]> =>
    (await getOk(`/api/recordings/${encodeURIComponent(run)}/events.json`)).json(),
  replayShadow: async (run: string, roi: string, target: number, ceiling?: number): Promise<ReplayShadow> =>
    (await getOk(replayShadowPath(run, roi, target, ceiling))).json(),
  autoLog: async (): Promise<{ enabled: boolean }> =>
    (await fetch(apiUrl(BASE, "/api/auto-log"))).json(),
  setAutoLog: (enabled: boolean) => put("/api/auto-log", { enabled }),
  /** Fetch a run's telemetry.csv and trigger a browser download. Throws with the server detail. */
  downloadRecording: async (run: string): Promise<void> => {
    const res = await fetch(apiUrl(BASE, `/api/recordings/${encodeURIComponent(run)}/telemetry.csv`));
    if (!res.ok) throw new Error(await detail(res));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run}_telemetry.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
