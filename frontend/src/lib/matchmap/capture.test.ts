import { test } from "node:test";
import assert from "node:assert/strict";
import { isStable, runCapture, averageGamma, type CaptureDeps } from "./capture.ts";
import { capturePlan } from "./plan.ts";

const h = (rows: Array<[number, number | null, number | null]>) => rows.map(([t, tune, load]) => ({ t, tune, load }));

test("isStable: flicker within the deadband over the whole window is stable", () => {
  const hist = h([[0, 28.6, 23.5], [500, 28.6, 23.6], [1000, 28.5, 23.5], [1600, 28.6, 23.6]]);
  assert.equal(isStable(hist, 1600, 1500, 0.15), true);
});

test("isStable: still moving, too short a history, or no readback is not stable", () => {
  assert.equal(isStable(h([[0, 27.0, 23.5], [800, 27.6, 23.5], [1600, 28.2, 23.5]]), 1600, 1500, 0.15), false);
  assert.equal(isStable(h([[900, 28.6, 23.5], [1600, 28.6, 23.5]]), 1600, 1500, 0.15), false);
  assert.equal(isStable(h([[0, 28.6, null], [1600, 28.6, null]]), 1600, 1500, 0.15), false);
});

test("averageGamma is the complex mean", () => {
  assert.deepEqual(averageGamma([{ re: 0.1, im: -0.2 }, { re: 0.3, im: 0.0 }]), { re: 0.2, im: -0.1 });
});

function fakeDeps(over: Partial<CaptureDeps> = {}) {
  const calls: string[] = [];
  const deps: CaptureDeps = {
    move: async (axis, v) => { calls.push(`move ${axis} ${v}`); },
    settle: async () => { calls.push("settle"); },
    measure: async () => { calls.push("measure"); return { tune: 28.6, load: 23.6, g: { re: 0, im: 0 } }; },
    shouldStop: () => false,
    ...over,
  };
  return { deps, calls };
}

test("runCapture: every move is followed by a settle, and each record measures once", async () => {
  const steps = capturePlan(29, 24, [0, 1], [0]);
  const { deps, calls } = fakeDeps();
  const res = await runCapture(steps, deps);
  assert.equal(res.stopped, false);
  assert.equal(res.points.length, 3); // 2 grid points + repeat
  calls.forEach((c, i) => { if (c.startsWith("move")) assert.equal(calls[i + 1], "settle"); });
  assert.equal(calls.filter((c) => c === "measure").length, 3);
  assert.deepEqual(res.points.map((p) => [p.cmdTune, p.cmdLoad, p.repeat]), [[29, 24, false], [30, 24, false], [29, 24, true]]);
});

test("runCapture: stop is honoured between steps and keeps what was measured", async () => {
  let n = 0;
  const { deps } = fakeDeps({
    measure: async () => { n++; return { tune: 1, load: 1, g: { re: 0, im: 0 } }; },
    shouldStop: () => n >= 2,
  });
  const res = await runCapture(capturePlan(29, 24, [-1, 0, 1], [0]), deps);
  assert.equal(res.stopped, true);
  assert.equal(res.points.length, 2);
});

test("runCapture: a measure failure rejects (the caller reports it; nothing half-fitted)", async () => {
  const { deps } = fakeDeps({ measure: async () => { throw new Error("sweep returned no data"); } });
  await assert.rejects(runCapture(capturePlan(29, 24, [0], [0]), deps), /no data/);
});

test("repeatDriftOhm: |dZ| between the repeat and the first visit to the same commanded point", async () => {
  const { repeatDriftOhm } = await import("./capture.ts");
  const p = (cmdTune: number, cmdLoad: number, g: { re: number; im: number }, repeat = false) =>
    ({ tune: cmdTune, load: cmdLoad, g, label: "", cmdTune, cmdLoad, repeat, t: 0 });
  // Γ = 0 is Z = 50; Γ = 0.2 is Z = 75
  assert.equal(repeatDriftOhm([p(29, 24, { re: 0, im: 0 }), p(30, 24, { re: 0.5, im: 0 }), p(29, 24, { re: 0.2, im: 0 }, true)])?.toFixed(6), "25.000000");
  assert.equal(repeatDriftOhm([p(29, 24, { re: 0, im: 0 })]), null);
});
