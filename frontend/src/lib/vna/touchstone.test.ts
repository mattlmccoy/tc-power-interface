import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTouchstone } from "./touchstone.ts";
import { magnitude, nearestPointByFrequency } from "./rf.ts";

const load = (f: string): ReturnType<typeof parseTouchstone> =>
  parseTouchstone(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

test("parses a real sweep: 13.56 MHz present, |Gamma| finite", () => {
  const pts = load("detuned.s1p");
  assert.ok(pts.length > 100, "expected a full sweep");
  const p = nearestPointByFrequency(pts, 13.56e6)!;
  assert.ok(Math.abs(p.frequency - 13.56e6) < 20000, "13.56 MHz grid point present");
  assert.ok(Number.isFinite(magnitude(p.s11)));
});

test("detuned vs matched differ at 13.56 (detuned much worse)", () => {
  const d = nearestPointByFrequency(load("detuned.s1p"), 13.56e6)!;
  const m = nearestPointByFrequency(load("matched.s1p"), 13.56e6)!;
  assert.ok(magnitude(d.s11) > 0.5, "detuned ~0.83");
  assert.ok(magnitude(m.s11) < 0.2, "matched ~0.064");
});

test("skips comment/header lines and leaves s21 zero", () => {
  const pts = load("matched.s1p");
  assert.equal(pts[0].s21.re, 0);
  assert.equal(pts[0].s21.im, 0);
});
