import assert from "node:assert/strict";
import test from "node:test";

import { middleTruncate, savedPath } from "./recordingView.ts";

// Shapes from backend api/app.py status()["recording"] (run_path, experiments_root) and
// GET /api/recordings items ({run, path, complete, size_bytes}).
const root = "/Users/op/TC-POWER/experiments";

test("middleTruncate: short strings unchanged, long ones keep head and tail", () => {
  assert.equal(middleTruncate("/a/b", 10), "/a/b");
  const s = "/Users/op/TC-POWER/experiments/20261007_run_42";
  const t = middleTruncate(s, 20);
  assert.equal(t.length, 20);
  assert.ok(t.startsWith("/Users/op"));
  assert.ok(t.endsWith("run_42"));
  assert.ok(t.includes("…"));
});

test("savedPath: active run shows its run_path", () => {
  const p = savedPath({ active: true, run: "r1", run_path: `${root}/r1`, experiments_root: root }, "r1", []);
  assert.deepEqual(p, { label: "Saved to:", path: `${root}/r1`, run: "r1" });
});

test("savedPath: idle with a last run uses that run's path from the recordings list", () => {
  const runs = [{ run: "r0", path: `${root}/r0` }, { run: "r1", path: `${root}/r1` }];
  const p = savedPath({ active: false, run: null, run_path: null, experiments_root: root }, "r1", runs);
  assert.deepEqual(p, { label: "Saved to:", path: `${root}/r1`, run: "r1" });
});

test("savedPath: idle with no known run path shows the experiments root", () => {
  const p = savedPath({ active: false, run: null, run_path: null, experiments_root: root }, null, []);
  assert.deepEqual(p, { label: "Runs save to:", path: root, run: null });
  const q = savedPath({ active: false, run: null, run_path: null, experiments_root: root }, "gone", []);
  assert.deepEqual(q, { label: "Runs save to:", path: root, run: null });
});

test("savedPath: older backend without the fields hides the line", () => {
  assert.equal(savedPath({ active: false, run: null }, "r1", null), null);
  assert.equal(savedPath(undefined, null, null), null);
});
