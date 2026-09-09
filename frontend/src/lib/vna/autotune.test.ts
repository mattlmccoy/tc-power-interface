import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planVnaStep, converged, gammaAt, F0, DEFAULT_MODEL } from "./autotune.ts";
import { parseTouchstone } from "./touchstone.ts";
import type { SweepPoint } from "./rf.ts";

const load = (f: string): SweepPoint[] =>
  parseTouchstone(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

// A 3-point synthetic sweep centred on F0 with a chosen S11 at F0.
const synth = (reAtF0: number, imAtF0 = 0): SweepPoint[] => [
  { frequency: F0 - 20000, s11: { re: 0.9, im: 0 }, s21: { re: 0, im: 0 } },
  { frequency: F0, s11: { re: reAtF0, im: imAtF0 }, s21: { re: 0, im: 0 } },
  { frequency: F0 + 20000, s11: { re: 0.9, im: 0 }, s21: { re: 0, im: 0 } },
];

test("matched real sweep → converged, action done", () => {
  const r = planVnaStep(load("matched.s1p"), { tune: 44, load: 44 }, DEFAULT_MODEL);
  assert.equal(r.converged, true);
  assert.equal(r.action, "done");
});

test("detuned real sweep → not converged, bounded in-range move, actually moves", () => {
  const r = planVnaStep(load("detuned.s1p"), { tune: 44, load: 44 }, DEFAULT_MODEL);
  assert.equal(r.converged, false);
  assert.ok(r.nextTune >= 0 && r.nextTune <= 100);
  assert.ok(r.nextLoad >= 0 && r.nextLoad <= 100);
  assert.ok(Math.abs(r.nextTune - 44) + Math.abs(r.nextLoad - 44) > 0, "proposes a move");
  assert.ok(r.action === "tune" || r.action === "load");
});

test("convergence gate: RL < -20 dB passes, a poor match does not", () => {
  assert.equal(converged(synth(0.02)[1]), true);  // |Γ|=0.02 → RL≈-34 dB
  assert.equal(converged(synth(0.5)[1]), false);   // |Γ|=0.5 → RL≈-6 dB
});

test("empty sweep → safe abort, caps unchanged", () => {
  const r = planVnaStep([], { tune: 30, load: 70 }, DEFAULT_MODEL);
  assert.equal(r.converged, false);
  assert.equal(r.nextTune, 30);
  assert.equal(r.nextLoad, 70);
  assert.ok(r.abort);
});

test("gammaAt picks the 13.56 MHz point", () => {
  const p = gammaAt(load("detuned.s1p"))!;
  assert.ok(Math.abs(p.frequency - F0) < 20000);
});
