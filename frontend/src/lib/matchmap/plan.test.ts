import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePlan, DEFAULT_TUNE_OFFSETS, DEFAULT_LOAD_OFFSETS, type Step } from "./plan.ts";

const records = (s: Step[]) => s.filter((x) => x.kind === "record");

// Walk the plan; for every record, check the LAST change on each axis was upward (approach from below:
// the 09-03 study saw 3.2 Ohm between approach directions, which the readback cannot see).
function assertApproachFromBelow(steps: Step[]) {
  const pos: Record<"tune" | "load", number | null> = { tune: null, load: null };
  const lastUp: Record<"tune" | "load", boolean> = { tune: false, load: false };
  for (const s of steps) {
    if (s.kind === "move") {
      if (pos[s.axis] !== null && s.value === pos[s.axis]) continue;
      lastUp[s.axis] = pos[s.axis] !== null && s.value > (pos[s.axis] as number);
      pos[s.axis] = s.value;
    } else {
      assert.ok(lastUp.tune && lastUp.load, `record ${s.label}: last moves tune-up=${lastUp.tune} load-up=${lastUp.load}`);
      assert.equal(pos.tune, s.tune);
      assert.equal(pos.load, s.load);
    }
  }
}

test("default grid is wide and symmetric (no direction baked in from one run): Tune ±6, Load ±6", () => {
  const steps = capturePlan(28.6, 23.6, DEFAULT_TUNE_OFFSETS, DEFAULT_LOAD_OFFSETS);
  const r = records(steps).filter((x) => x.kind === "record" && !x.repeat);
  const tunes = [...new Set(r.map((x) => (x.kind === "record" ? x.tune : 0)))];
  const loads = [...new Set(r.map((x) => (x.kind === "record" ? x.load : 0)))];
  assert.deepEqual(tunes, [23, 25, 27, 28, 29, 30, 31, 33, 35]);
  assert.deepEqual(loads, [18, 20, 22, 24, 26, 28, 30]); // Load is broad: 2 % steps
  assert.equal(records(steps).length, 9 * 7 + 1);
  const last = records(steps).at(-1);
  assert.ok(last?.kind === "record" && last.repeat && last.tune === 29 && last.load === 24);
});

test("every recorded point is approached from below on both caps", () => {
  assertApproachFromBelow(capturePlan(28.6, 23.6, DEFAULT_TUNE_OFFSETS, DEFAULT_LOAD_OFFSETS));
  assertApproachFromBelow(capturePlan(50, 50, [-2, 0, 2], [1, -1, 0])); // unsorted offsets
});

test("commands stay inside 0..100 and duplicate points after clamping are dropped", () => {
  const steps = capturePlan(99.7, 0.4, [-1, 0, 1], [-1, 0, 1]);
  for (const s of steps) if (s.kind === "move") assert.ok(s.value >= 0 && s.value <= 100, `${s.value}`);
  const keys = records(steps).filter((s) => s.kind === "record" && !s.repeat)
    .map((s) => (s.kind === "record" ? `${s.tune}/${s.load}` : ""));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 2 * 2); // tune {99,100}, load {0,1}
});

test("a cap already at its target is not left one step below it (single Load level)", () => {
  const steps = capturePlan(29, 24, [0, 1], [0]);
  assertApproachFromBelow(steps);
  // the Load reached 24 from below once; later columns must not re-drop it and forget to come back
  const loadMoves = steps.filter((s) => s.kind === "move" && s.axis === "load").map((s) => (s.kind === "move" ? s.value : 0));
  assert.deepEqual(loadMoves, [23, 24]);
});

test("gridOffsets: symmetric, 1 % steps inside ±fine, coarser steps out to ±span", async () => {
  const { gridOffsets } = await import("./plan.ts");
  assert.deepEqual(gridOffsets(6, 2, 2), [-6, -4, -2, -1, 0, 1, 2, 4, 6]);
  assert.deepEqual(gridOffsets(6, 0, 2), [-6, -4, -2, 0, 2, 4, 6]);
  assert.deepEqual(gridOffsets(1, 1, 2), [-1, 0, 1]);
  assert.deepEqual(gridOffsets(5, 2, 2), [-5, -4, -2, -1, 0, 1, 2, 4, 5]); // the span itself is always sampled
});
