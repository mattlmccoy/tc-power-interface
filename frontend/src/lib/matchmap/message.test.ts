import { test } from "node:test";
import assert from "node:assert/strict";
import { aidMessage } from "./message.ts";
import type { LocateResult } from "./locate.ts";

const res = (over: Partial<LocateResult>): LocateResult => ({
  status: "none", grid: { tune: [], load: [] }, cells: new Uint8Array(), estimate: null, sigma: 0.02,
  worstGamma: Infinity, edge: false, ...over,
});
const g = (t: string, l: string, ta: number | null = null, la: number | null = null) =>
  ({ tune: { dir: t as never, amount: ta }, load: { dir: l as never, amount: la } });

test("no readings: says what it needs, depending on RF", () => {
  assert.match(aidMessage(res({}), null, 0, false).text, /RF is on.*10 W/);
  assert.match(aidMessage(res({}), null, 0, true).text, /hold.*2 s/i);
});

test("spot: direction and size per cap, plus the worst-case reflected power at the current forward power", () => {
  const m = aidMessage(res({ status: "spot", estimate: { tune: 28.4, load: 25.1 }, worstGamma: 0.1 }), g("down", "up", -0.43, 1.2), 100, true);
  assert.match(m.text, /Tune ↓ 0\.4 %/);
  assert.match(m.text, /Load ↑ 1\.2 %/);
  assert.match(m.text, /≤ 1\.0 W/); // 0.1² × 100 W
  assert.equal(m.tone, "info");
});

test("spot where the operator already is: hold", () => {
  const m = aidMessage(res({ status: "spot", estimate: { tune: 28.4, load: 25.1 }, worstGamma: 0.05 }), g("hold", "hold", 0.05, -0.2), 100, true);
  assert.match(m.text, /hold/i);
  assert.equal(m.tone, "ok");
});

test("ring: asks for one more held move; names any cap whose direction is already certain", () => {
  const m = aidMessage(res({ status: "ring", estimate: { tune: 1, load: 1 }, worstGamma: 0.3 }), g("up", "unknown", 0.6), 100, true);
  assert.match(m.text, /one cap.*one step.*2 s/i);
  assert.match(m.text, /Tune ↑/);
  assert.doesNotMatch(m.text, /Load [↑↓]/);
});

test("edge and nofit are warnings that send the operator back to tuning by hand", () => {
  const e = aidMessage(res({ status: "ring", edge: true, estimate: { tune: 1, load: 1 } }), g("unknown", "unknown"), 100, true);
  assert.match(e.text, /beyond the calibrated range/);
  assert.equal(e.tone, "warn");
  const n = aidMessage(res({ status: "nofit" }), null, 100, true);
  assert.match(n.text, /don't fit the cold map/);
  assert.match(n.text, /by hand/);
  assert.equal(n.tone, "warn");
});

test("matched: hold, no move advice", () => {
  const m = aidMessage(res({ status: "matched", estimate: { tune: 17.8, load: 8.6 }, worstGamma: 0.04 }), g("hold", "hold", 0, 0), 40, true);
  assert.match(m.text, /Matched.*Hold/);
  assert.equal(m.tone, "ok");
});
