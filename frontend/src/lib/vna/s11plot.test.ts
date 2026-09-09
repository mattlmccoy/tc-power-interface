import test from "node:test";
import assert from "node:assert/strict";
import { s11PlotPoints } from "./s11plot.ts";
import type { SweepPoint } from "./rf.ts";

const box = { width: 600, height: 100, dbMin: -40, dbMax: 0, fMin: 12e6, fMax: 18e6 };
const pt = (f: number, re: number, im = 0): SweepPoint => ({ frequency: f, s11: { re, im }, s21: { re: 0, im: 0 } });

test("maps frequency→x, dB→y (0 dB at top), and the 13.56 marker", () => {
  const { points, markerX } = s11PlotPoints([pt(12e6, 1), pt(18e6, 1)], box); // |Γ|=1 → 0 dB → y=0
  assert.equal(points, "0.0,0.0 600.0,0.0");
  assert.equal(markerX, ((13.56e6 - 12e6) / (18e6 - 12e6)) * 600); // 156
});

test("a deep dip lands near the bottom; dB clamps to dbMin", () => {
  const { points } = s11PlotPoints([pt(13.56e6, 0.01)], { ...box, width: 100 }); // |Γ|=0.01 → −40 dB → y=100
  assert.ok(points.endsWith(",100.0"), points);
});
