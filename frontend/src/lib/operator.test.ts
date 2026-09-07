import assert from "node:assert/strict";
import test from "node:test";

import {
  apiUrl,
  checkHandshake,
  DEFAULT_SITE_BASE,
  loadOperatorBase,
  normalizeBase,
  UI_API_VERSION,
  wsUrl,
} from "./operator.ts";

test("apiUrl prefixes the operator base", () => {
  assert.equal(apiUrl("", "/api/status"), "/api/status");
  assert.equal(apiUrl("http://localhost:8000", "/api/status"), "http://localhost:8000/api/status");
});

test("wsUrl derives scheme from the page location when base is empty", () => {
  assert.equal(
    wsUrl("", "/ws/telemetry", { protocol: "http:", host: "localhost:5174" }),
    "ws://localhost:5174/ws/telemetry",
  );
  assert.equal(
    wsUrl("", "/ws/telemetry", { protocol: "https:", host: "rig.lab" }),
    "wss://rig.lab/ws/telemetry",
  );
});

test("wsUrl derives scheme from an explicit operator base", () => {
  assert.equal(wsUrl("http://localhost:8000", "/ws/telemetry"), "ws://localhost:8000/ws/telemetry");
  assert.equal(wsUrl("https://host:9000", "/ws/telemetry"), "wss://host:9000/ws/telemetry");
});

test("normalizeBase strips trailing slash and rejects non-URLs", () => {
  assert.equal(normalizeBase(""), "");
  assert.equal(normalizeBase("http://localhost:8000/"), "http://localhost:8000");
  assert.equal(normalizeBase("not a url"), null);
});

test("loadOperatorBase falls back by site mode", () => {
  assert.equal(loadOperatorBase(null, { siteMode: true }), DEFAULT_SITE_BASE);
  assert.equal(loadOperatorBase(null, { siteMode: false }), "");
});

test("checkHandshake: same ok, minor warns, major refuses, missing refuses", () => {
  assert.deepEqual(checkHandshake("0.1", "0.1"), { level: "ok" });
  assert.equal(checkHandshake("0.1", "0.2").level, "warn");
  assert.equal(checkHandshake("0.1", "1.0").level, "refuse");
  assert.equal(checkHandshake("0.1", undefined).level, "refuse");
  // the UI speaks a real API version
  assert.deepEqual(checkHandshake(UI_API_VERSION, UI_API_VERSION), { level: "ok" });
});
