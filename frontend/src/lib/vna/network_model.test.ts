import test from "node:test";
import assert from "node:assert/strict";
import { zAt, s11At, DEFAULT_NETWORK } from "./network_model.ts";
import { magnitude } from "./rf.ts";

const { tStar, lStar, f0 } = DEFAULT_NETWORK;

test("optimum caps give a 50Ω match (Z≈50+j0, |Γ|≈0)", () => {
  const z = zAt(tStar, lStar);
  assert.ok(Math.abs(z.re - 50) < 0.5 && Math.abs(z.im) < 0.5, `Z=${z.re}+j${z.im}`);
  assert.ok(magnitude(s11At(f0, tStar, lStar)) < 0.01);
});

test("a 3% tune detune is a bad match (sharp tune well)", () => {
  assert.ok(magnitude(s11At(f0, tStar + 3, lStar)) > 0.3);
});

test("coupling: moving tune shifts BOTH R and X, not just X", () => {
  const z0 = zAt(tStar, lStar);
  const zt = zAt(tStar + 2, lStar);
  assert.ok(Math.abs(zt.re - z0.re) > 1, "R moved with tune (coupling)");
  assert.ok(Math.abs(zt.im - z0.im) > 1, "X moved with tune");
});
