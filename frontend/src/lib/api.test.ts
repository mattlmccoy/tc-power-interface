import assert from "node:assert/strict";
import test from "node:test";

import { api } from "./api.ts";

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
