import assert from "node:assert/strict";
import test from "node:test";

import { TraceBuffer } from "./telemetry.ts";

test("TraceBuffer keeps the last N points in insertion order", () => {
  const b = new TraceBuffer(3);
  b.push(1, 10);
  b.push(2, 20);
  b.push(3, 30);
  b.push(4, 40);
  assert.deepEqual(b.toArray(), [
    { t: 2, v: 20 },
    { t: 3, v: 30 },
    { t: 4, v: 40 },
  ]);
});

test("TraceBuffer starts empty", () => {
  assert.deepEqual(new TraceBuffer(5).toArray(), []);
});
