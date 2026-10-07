import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  PANEL_IDS,
  generatorSummary,
  loadLayout,
  movePanel,
  normalizeLayout,
  resetLayout,
  saveLayout,
  toggleCollapsed,
} from "./layout.ts";
import type { Layout } from "./layout.ts";

const fakeStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
};

test("default layout matches today's dashboard and contains every panel once", () => {
  assert.deepEqual(DEFAULT_LAYOUT.left, ["telemetry", "rfpower", "generator", "history", "senseloop"]);
  assert.deepEqual(DEFAULT_LAYOUT.right, ["matchnet", "matchaid", "matchtuner", "timer", "recording"]);
  assert.deepEqual([...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.right].sort(), [...PANEL_IDS].sort());
  assert.deepEqual(DEFAULT_LAYOUT.collapsed, []);
});

test("normalizeLayout: corrupt input falls back to the default", () => {
  assert.deepEqual(normalizeLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout("garbage"), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout({ left: 5, right: null }), DEFAULT_LAYOUT);
});

test("normalizeLayout: drops unknown + duplicate ids, appends missing panels to their default column", () => {
  const n = normalizeLayout({
    left: ["senseloop", "bogus", "telemetry", "telemetry"],
    right: ["recording"],
    collapsed: ["history", "nope", "history"],
  });
  assert.deepEqual(n.left.slice(0, 2), ["senseloop", "telemetry"]);
  // missing left-default panels appended in default order
  assert.deepEqual(n.left.slice(2), ["rfpower", "generator", "history"]);
  assert.deepEqual(n.right, ["recording", "matchnet", "matchaid", "matchtuner", "timer"]);
  assert.deepEqual(n.collapsed, ["history"]);
});

test("movePanel: within a column, across columns, clamped index, onto itself", () => {
  const a = movePanel(DEFAULT_LAYOUT, "senseloop", "left", 2);
  assert.deepEqual(a.left, ["telemetry", "rfpower", "senseloop", "generator", "history"]);
  const b = movePanel(DEFAULT_LAYOUT, "timer", "left", 0);
  assert.equal(b.left[0], "timer");
  assert.ok(!b.right.includes("timer"));
  const c = movePanel(DEFAULT_LAYOUT, "history", "right", 999);
  assert.equal(c.right.at(-1), "history");
  const d = movePanel(DEFAULT_LAYOUT, "generator", "left", 2);
  assert.deepEqual(d, DEFAULT_LAYOUT);
  assert.notEqual(a, DEFAULT_LAYOUT); // pure: returns a new object
  assert.deepEqual(DEFAULT_LAYOUT.left, ["telemetry", "rfpower", "generator", "history", "senseloop"]);
});

test("toggleCollapsed adds then removes", () => {
  const a = toggleCollapsed(DEFAULT_LAYOUT, "history");
  assert.deepEqual(a.collapsed, ["history"]);
  assert.deepEqual(toggleCollapsed(a, "history").collapsed, []);
});

test("save/load round-trip; unavailable storage gives the default", () => {
  const s = fakeStorage();
  const l: Layout = toggleCollapsed(movePanel(DEFAULT_LAYOUT, "senseloop", "left", 0), "generator");
  saveLayout(s, l);
  assert.ok(s.getItem(LAYOUT_KEY));
  assert.deepEqual(loadLayout(s), l);
  assert.deepEqual(loadLayout(null), DEFAULT_LAYOUT);
  s.setItem(LAYOUT_KEY, "{not json");
  assert.deepEqual(loadLayout(s), DEFAULT_LAYOUT);
});

test("generatorSummary: temp text + tempBar color; unknown is never 0 °C", () => {
  const s = generatorSummary({ temperature_c: 41.2 }, { temperature_c_trip: 60 });
  assert.equal(s.text, "internal temp 41.2 °C");
  assert.match(s.color ?? "", /^hsl\(/);
  assert.deepEqual(generatorSummary(null, { temperature_c_trip: 60 }), { text: "internal temp —", color: null });
  assert.deepEqual(generatorSummary({ temperature_c: 30 }, undefined), { text: "internal temp 30.0 °C", color: null });
});

test("resetLayout returns a fresh copy of the default", () => {
  const r = resetLayout();
  assert.deepEqual(r, DEFAULT_LAYOUT);
  assert.notEqual(r, DEFAULT_LAYOUT);
  r.left.push("timer"); // mutable, and mutating it never touches the default
  assert.equal(DEFAULT_LAYOUT.left.length, 5);
});
