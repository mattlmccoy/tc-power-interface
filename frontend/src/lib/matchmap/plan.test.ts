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

test("default grid: 3 Tune x 5 Load points plus a repeat of the start", () => {
  const steps = capturePlan(28.6, 23.6, DEFAULT_TUNE_OFFSETS, DEFAULT_LOAD_OFFSETS);
  const r = records(steps);
  assert.equal(r.length, 3 * 5 + 1);
  const last = r[r.length - 1];
  assert.ok(last.kind === "record" && last.repeat === true);
  assert.equal(last.kind === "record" && last.tune, 29); // the start rounds to whole-percent commands
  assert.equal(last.kind === "record" && last.load, 24);
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
