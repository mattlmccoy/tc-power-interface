import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitMap, predictZ, predictGammaMag, solveMatch, gammaOfZ, MIN_SPREAD, type MapPoint } from "./fit.ts";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

// Z = 50 + a·dT + b·dL (+ q·dT²) around (28, 24) — a known truth to recover.
const truth = (T: number, L: number, q = 0) => {
  const dT = T - 28, dL = L - 24;
  return { re: 50 - 15 * dT + 3 * dL + q * dT * dT, im: 2 * dT - 1 * dL };
};
const zToG = (z: { re: number; im: number }) => gammaOfZ(z);
const grid = (ts: number[], ls: number[], q = 0): MapPoint[] =>
  ts.flatMap((T) => ls.map((L) => ({ tune: T, load: L, g: zToG(truth(T, L, q)) })));

const close = (a: number, b: number, tol: number, what = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

test("recovers a linear map: predictions match the truth off the grid", () => {
  const fit = fitMap(grid([27, 28, 29], [22, 24, 26]));
  const z = predictZ(fit, 28.4, 25.1);
  const t = truth(28.4, 25.1);
  close(z.re, t.re, 1e-6, "R");
  close(z.im, t.im, 1e-6, "X");
  assert.ok(fit.rmsOhm < 1e-6);
  assert.ok(fit.looRmsOhm != null && fit.looRmsOhm < 1e-6);
});

test("uses a quadratic model when the grid supports it, and it captures curvature", () => {
  const fit = fitMap(grid([27, 28, 29], [22, 23, 24, 25, 26], 4));
  assert.equal(fit.kind, "quadratic");
  const z = predictZ(fit, 28.6, 23.3);
  close(z.re, truth(28.6, 23.3, 4).re, 1e-6, "R");
});

test("solveMatch finds where the map predicts Z = 50 Ohm", () => {
  const fit = fitMap(grid([27, 28, 29], [22, 24, 26]));
  const m = solveMatch(fit);
  close(m.tune, 28, 0.05, "tune");
  close(m.load, 24, 0.2, "load");
  assert.ok(m.gamma < 0.01, `gamma ${m.gamma}`);
  close(predictGammaMag(fit, m.tune, m.load), m.gamma, 1e-12);
});

test("refuses fewer than 4 points", () => {
  assert.throws(() => fitMap(grid([27, 28], [22])), /at least 4/);
});

test("REAL 09-30 tune-only log: Load only flickers 23.5/23.6, so a 2-D map is refused", () => {
  const { entries } = fixture("tuneonly_0930.json");
  const pts: MapPoint[] = entries.map((e: { tune: number; load: number; R: number; X: number }) => ({
    tune: e.tune, load: e.load, g: zToG({ re: e.R, im: e.X }),
  }));
  assert.throws(() => fitMap(pts), new RegExp(`spread.*${MIN_SPREAD}`));
});

test("REAL 09-03 study: a star of single-cap moves fits linear and predicts the held-out combined moves within 3 Ohm", () => {
  const { points } = fixture("fullcap_0903.json");
  const toPt = (p: { tune: number; load: number; g: { re: number; im: number } }): MapPoint => ({ tune: p.tune, load: p.load, g: p.g });
  const train = points.filter((p: { set: string }) => p.set !== "COOR").map(toPt);
  const held = points.filter((p: { set: string }) => p.set === "COOR").map(toPt);
  const fit = fitMap(train);
  assert.equal(fit.kind, "linear"); // a star has no off-axis points, so the cross term is unidentifiable
  for (const h of held) {
    const zp = predictZ(fit, h.tune, h.load);
    const g = h.g;
    const den = (1 - g.re) ** 2 + g.im ** 2;
    const zm = { re: 50 * (1 - g.re ** 2 - g.im ** 2) / den, im: 50 * 2 * g.im / den };
    const miss = Math.hypot(zp.re - zm.re, zp.im - zm.im);
    assert.ok(miss < 3, `held-out T${h.tune} L${h.load} missed by ${miss.toFixed(2)} Ohm`);
  }
});

test("REAL 09-30 captures: the fit picks the model with the lowest held-out error — Γ-space beats the old Z quadratic", () => {
  // Z-space quadratic (v0.12) held-out error: v1 3.35 Ohm, v3 2.73 Ohm. Γ-space quadratic measured 2.34 on v1.
  for (const [f, zQuadLoo] of [["map_v1_0930.json", 3.35], ["map_v3_0930.json", 2.73]] as const) {
    const pts = fixture(f).points.filter((p: { repeat: boolean }) => !p.repeat);
    const fit = fitMap(pts);
    assert.equal(fit.space, "gamma", f);
    assert.ok(fit.looRmsOhm != null && fit.looRmsOhm < zQuadLoo - 0.3, `${f}: held-out ${fit.looRmsOhm} vs Z-quadratic ${zQuadLoo}`);
  }
});

test("a wide Tune span that curves is fitted with a cubic, not forced into a quadratic", () => {
  const z = (T: number, L: number) => { const dT = T - 20, dL = L - 10; return { re: 50 - 16 * dT + 3 * dL + 0.9 * dT * dT * dT / 10, im: -4 * dT - 3.4 * dL + 0.5 * dT * dT }; };
  const pts: MapPoint[] = [];
  for (let T = 12; T <= 21; T++) for (const L of [6, 8, 10, 12, 14]) pts.push({ tune: T, load: L, g: gammaOfZ(z(T, L)) });
  const fit = fitMap(pts);
  assert.equal(fit.kind, "cubic");
  const zp = predictZ(fit, 14.5, 9), zt = z(14.5, 9);
  assert.ok(Math.hypot(zp.re - zt.re, zp.im - zt.im) < 1, `miss ${Math.hypot(zp.re - zt.re, zp.im - zt.im)}`);
});

test("fitQuality: a map whose held-out error is above 3 Ohm is flagged rough with a suggestion", async () => {
  const { fitQuality } = await import("./fit.ts");
  const good = fitMap(fixture("rematch_1002.json").points.filter((p: { repeat: boolean }) => !p.repeat)); // REAL, 1.08 Ohm
  assert.equal(fitQuality(good).rough, false);
  const rough = { ...good, looRmsOhm: 8.3 }; // the 2026-10-06 Quick capture
  const q = fitQuality(rough);
  assert.equal(q.rough, true);
  assert.match(q.text, /8\.3 Ω/);
  assert.match(q.text, /Full/);
  assert.equal(fitQuality({ ...good, looRmsOhm: null, rmsOhm: 4.2 }).rough, true); // no held-out figure: judge the fit itself
});
