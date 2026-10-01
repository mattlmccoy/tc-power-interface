import { test } from "node:test";
import assert from "node:assert/strict";
import { gammaOfZ, predictZ } from "./fit.ts";
import { serializeMap, parseMap, saveActiveMap, loadActiveMap, MAP_KEY } from "./store.ts";
import type { CapturedPoint } from "./capture.ts";

const pts: CapturedPoint[] = [27.6, 28.6, 29.6].flatMap((T, i) => [19.6, 23.6, 27.6].map((L, j) => ({
  tune: T, load: L, g: gammaOfZ({ re: 50 - 16 * (T - 28.6) - 2.7 * (L - 23.6), im: -4 * (T - 28.6) - 3.4 * (L - 23.6) }),
  label: `T${T} L${L}`, cmdTune: 28 + i, cmdLoad: 20 + 4 * j, repeat: false, t: 1790800000000,
})));

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); },
  };
}

test("round trip keeps the points and refits the same map", () => {
  const text = serializeMap({ label: "218-2core_v2", build: "v0.12.0 · abc", createdAt: "2026-09-30T20:00:00Z", points: pts });
  const m = parseMap(text);
  assert.equal(m.label, "218-2core_v2");
  assert.equal(m.points.length, 9);
  const z = predictZ(m.fit, 28.6, 23.6);
  assert.ok(Math.abs(z.re - 50) < 1e-6 && Math.abs(z.im) < 1e-6);
  assert.ok(Math.abs(m.coldMatch.tune - 28.6) < 0.05);
});

test("rejects junk, a wrong version, and malformed points", () => {
  assert.throws(() => parseMap("not json"), /not a match map/);
  assert.throws(() => parseMap(JSON.stringify({ kind: "tcp-match-map", version: 99, points: [] })), /version/);
  assert.throws(() => parseMap(JSON.stringify({ kind: "tcp-match-map", version: 1, label: "x", points: [{ tune: "a" }] })), /point 0/);
  assert.throws(() => parseMap(JSON.stringify({ kind: "something-else", version: 1, points: [] })), /not a match map/);
});

test("active map in storage: saved, loaded, and junk or missing storage gives null", () => {
  const st = memStorage();
  assert.equal(loadActiveMap(st), null);
  saveActiveMap(st, serializeMap({ label: "a", build: "b", createdAt: "c", points: pts }));
  assert.equal(loadActiveMap(st)?.label, "a");
  st.setItem(MAP_KEY, "{broken");
  assert.equal(loadActiveMap(st), null);
  assert.equal(loadActiveMap(null), null);
});
