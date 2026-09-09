import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  gammaToXY,
  constResistanceCircle,
  constReactanceCircle,
  RESISTANCE_GRID,
  REACTANCE_GRID,
} from "./smith.ts";
import { parseTouchstone } from "./touchstone.ts";
import { nearestPointByFrequency } from "./rf.ts";

const F = { cx: 100, cy: 100, r: 60 };

test("gammaToXY maps Γ=0 to the centre and inverts the imaginary axis", () => {
  assert.deepEqual(gammaToXY({ re: 0, im: 0 }, F), { x: 100, y: 100 });
  assert.deepEqual(gammaToXY({ re: 1, im: 0 }, F), { x: 160, y: 100 }); // open, right rim
  assert.deepEqual(gammaToXY({ re: 0, im: 1 }, F), { x: 100, y: 40 }); // +im is up (screen y down)
  assert.deepEqual(gammaToXY({ re: -1, im: 0 }, F), { x: 40, y: 100 }); // short, left rim
});

test("constant-resistance circle: r=1 sits at (cx+r/2, cy) with radius r/2", () => {
  const c = constResistanceCircle(1, F);
  assert.equal(c.cx, 130);
  assert.equal(c.cy, 100);
  assert.equal(c.r, 30);
});

test("constant-resistance circle: r=0 is the whole unit circle", () => {
  const c = constResistanceCircle(0, F);
  assert.equal(c.cx, 100);
  assert.equal(c.r, 60);
});

test("constant-reactance circle: x=±1 centres at the right rim, radius = frame r", () => {
  const up = constReactanceCircle(1, F);
  assert.deepEqual({ cx: up.cx, cy: up.cy, r: up.r }, { cx: 160, cy: 40, r: 60 });
  const down = constReactanceCircle(-1, F);
  assert.deepEqual({ cx: down.cx, cy: down.cy, r: down.r }, { cx: 160, cy: 160, r: 60 });
});

test("grids are the standard normalized values", () => {
  assert.deepEqual([...RESISTANCE_GRID], [0.5, 1, 2]);
  assert.deepEqual([...REACTANCE_GRID], [0.5, 1, 2]);
});

test("a real matched sweep maps inside the 200×200 chart; 13.56 marker sits near centre", () => {
  const pts = parseTouchstone(readFileSync(new URL("./fixtures/matched.s1p", import.meta.url), "utf8"));
  const frame = { cx: 100, cy: 100, r: 90 };
  for (const pt of pts) {
    const q = gammaToXY(pt.s11, frame);
    assert.ok(q.x >= 0 && q.x <= 200 && q.y >= 0 && q.y <= 200, "trace point in-bounds");
  }
  const m = nearestPointByFrequency(pts, 13.56e6)!;
  const q = gammaToXY(m.s11, frame);
  assert.ok(Math.hypot(q.x - 100, q.y - 100) < 20, "matched marker near centre");
});
