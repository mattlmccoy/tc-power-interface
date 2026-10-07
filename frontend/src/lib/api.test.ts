import assert from "node:assert/strict";
import test from "node:test";

import { api, replayShadowPath } from "./api.ts";

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** Replace global fetch with a stub that records each request and returns an empty 200 JSON. */
function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

test("saveSafetyLimits issues a PUT (not POST) to /api/safety-limits", async () => {
  const calls = stubFetch();
  await api.saveSafetyLimits({
    max_forward_w: 300,
    max_reflected_w: 20,
    temperature_c_trip: 60,
    forward_caution_w: 400,
    forward_danger_w: 500,
  });
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /\/api\/safety-limits$/);
});

test("saveThermalPlan issues a PUT to /api/thermal/plan with the plan body", async () => {
  const calls = stubFetch();
  await api.saveThermalPlan({
    target_c: 150,
    soak_s: 30,
    approach_band_c: 15,
    loop_ceiling_w: 200,
    max_step_w: 25,
    done_below_c: 50,
  });
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /\/api\/thermal\/plan$/);
  assert.equal(calls[0].body?.target_c, 150);
});

test("thermalStart posts the mode to /api/thermal/start", async () => {
  const calls = stubFetch();
  await api.thermalStart("auto");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/api\/thermal\/start$/);
  assert.equal(calls[0].body?.mode, "auto");
});

test("thermalArm/thermalDisarm/thermalStop post to their routes", async () => {
  const calls = stubFetch();
  await api.thermalArm();
  await api.thermalDisarm();
  await api.thermalStop();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["POST", "POST", "POST"],
  );
  assert.match(calls[0].url, /\/api\/thermal\/arm$/);
  assert.match(calls[1].url, /\/api\/thermal\/disarm$/);
  assert.match(calls[2].url, /\/api\/thermal\/stop$/);
});

test("setAutoLog issues a PUT to /api/auto-log with the flag", async () => {
  const calls = stubFetch();
  await api.setAutoLog(false);
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /\/api\/auto-log$/);
  assert.equal(calls[0].body?.enabled, false);
});

test("thermalSource posts type and url to /api/thermal/source", async () => {
  const calls = stubFetch();
  await api.thermalSource("flir", "ws://x/ws/frames");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/api\/thermal\/source$/);
  assert.equal(calls[0].body?.type, "flir");
  assert.equal(calls[0].body?.url, "ws://x/ws/frames");
});

test("saveMatchTuner issues a PUT to /api/match-tuner with the config body", async () => {
  const calls = stubFetch();
  await api.saveMatchTuner({ mode: "auto", tune_step: 1, load_step: 0.3, guard: 0.6 });
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /\/api\/match-tuner$/);
  assert.equal(calls[0].body?.mode, "auto");
  assert.equal(calls[0].body?.tune_step, 1);
});

test("matchTunerStart/Arm/Disarm/Stop post to their routes", async () => {
  const calls = stubFetch();
  await api.matchTunerStart();
  await api.matchTunerArm();
  await api.matchTunerDisarm();
  await api.matchTunerStop();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["POST", "POST", "POST", "POST"],
  );
  assert.match(calls[0].url, /\/api\/match-tuner\/start$/);
  assert.match(calls[1].url, /\/api\/match-tuner\/arm$/);
  assert.match(calls[2].url, /\/api\/match-tuner\/disarm$/);
  assert.match(calls[3].url, /\/api\/match-tuner\/stop$/);
});

test("replayShadowPath encodes the run and ROI", () => {
  assert.equal(
    replayShadowPath("20261002_125227_RF", "SQ SAMPLE", 55),
    "/api/recordings/20261002_125227_RF/shadow?roi=SQ%20SAMPLE&target=55",
  );
  assert.equal(replayShadowPath("r/1", "a&b", 55.5, 120), "/api/recordings/r%2F1/shadow?roi=a%26b&target=55.5&ceiling=120");
});

test("replayShadowPath refuses a non-finite target or ceiling instead of sending target=NaN", () => {
  assert.throws(() => replayShadowPath("r", "x", NaN), /target/);
  assert.throws(() => replayShadowPath("r", "x", Infinity), /target/);
  assert.throws(() => replayShadowPath("r", "x", 55, NaN), /ceiling/);
});

test("replayShadow with a bad target rejects without touching the network", async () => {
  const calls = stubFetch();
  await assert.rejects(api.replayShadow("r", "x", NaN), /target/);
  assert.equal(calls.length, 0);
});

test("cockpit writes: setWatch, setRunMode and engageLoop post to their routes with the body", async () => {
  const calls = stubFetch();
  await api.setWatch(["core_a", "core_b"]);
  await api.setRunMode({ mode: "ladder", ladder_w: [20, 40], fixed_w: 0, fixed_min: 0 });
  await api.engageLoop();
  assert.deepEqual(calls.map((c) => c.method), ["POST", "POST", "POST"]);
  assert.match(calls[0].url, /\/api\/thermal\/watch$/);
  assert.deepEqual(calls[0].body, { names: ["core_a", "core_b"] });
  assert.match(calls[1].url, /\/api\/run-mode$/);
  assert.deepEqual(calls[1].body, { mode: "ladder", ladder_w: [20, 40], fixed_w: 0, fixed_min: 0 });
  assert.match(calls[2].url, /\/api\/thermal\/engage$/);
});

/** A fetch stub that answers every request with one canned response (json and text).
 * The bodies passed to it below are HAND-WRITTEN, SHAPE-ONLY fixtures (they follow the backend
 * handlers in api/app.py and recording/replay_shadow.py, but were not captured from a live
 * response), except the events.json entry's timestamp and label, which come from a real recorder run (its `data` is simplified). These tests
 * prove URL/method/body wiring and error handling, not that the backend's JSON means what is assumed. */
function stubReply(status: number, body: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: undefined });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

test("recording reads hit the run's routes and return the parsed body (shape-only fixtures)", async () => {
  // shape-only (hand-written): GET /api/recordings -> {runs:[{run, complete, size_bytes, has_roi_data}]}
  const runs = { runs: [{ run: "20261007_141544_cap", complete: true, size_bytes: 1234, has_roi_data: true }] };
  let calls = stubReply(200, runs);
  assert.deepEqual(await api.recordings(), runs.runs);
  assert.match(calls[0].url, /\/api\/recordings$/);

  calls = stubReply(200, { rois: ["SQ SAMPLE", "core 1"] });
  assert.deepEqual(await api.recordingRois("r 1"), ["SQ SAMPLE", "core 1"]);
  assert.match(calls[0].url, /\/api\/recordings\/r%201\/rois$/);

  // timestamp/label captured from a real events.json written by TelemetryRecorder (2026-10-07); data simplified
  const ev = [{ host_timestamp_ns: 1791396878208639000, label: "recording_started", data: { name: "x" } }];
  calls = stubReply(200, ev);
  assert.deepEqual(await api.recordingEvents("r"), ev);
  assert.match(calls[0].url, /\/api\/recordings\/r\/events\.json$/);

  calls = stubReply(200, "a,b\r\n1,2\r\n");
  assert.equal(await api.recordingCsv("r"), "a,b\r\n1,2\r\n");
  assert.match(calls[0].url, /\/api\/recordings\/r\/telemetry\.csv$/);

  // shape-only (hand-written): GET /api/recordings/{run}/shadow -> {roi, target_c, points:[...]}
  const shadow = { roi: "SQ SAMPLE", target_c: 55, points: [{ t_s: 0, temp_c: 30, k_c_per_w: null, tau_s: null, confidence: 0, suggest_w: null, plateau_c: null }] };
  calls = stubReply(200, shadow);
  assert.deepEqual(await api.replayShadow("r", "SQ SAMPLE", 55), shadow);
  assert.match(calls[0].url, /\/api\/recordings\/r\/shadow\?roi=SQ%20SAMPLE&target=55$/);
});

test("recording reads throw the server's detail on an error status (shape-only error bodies)", async () => {
  stubReply(404, { detail: "no events for this recording" });
  await assert.rejects(api.recordingEvents("r"), /no events for this recording/);
  stubReply(422, { detail: "damaged recording: x" });
  await assert.rejects(api.replayShadow("r", "x", 55), /damaged recording/);
  await assert.rejects(api.recordingCsv("r"), /damaged recording/);
});
