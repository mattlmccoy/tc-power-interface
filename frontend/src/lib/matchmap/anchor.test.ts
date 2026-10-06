// Re-anchoring: one VNA reading (complex Z at a known cap readback) solves the map's 2-D shift, so a map
// captured once per network build can be re-used each session instead of re-captured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMap, anchorMapText } from "./store.ts";
import { solveAnchor, AnchorError } from "./anchor.ts";
import { predictZ, zOfGamma } from "./fit.ts";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const day1 = fx("hvprobe_1001.json"); // 10-01 capture
const day2 = parseMap(fx("rematch_1002.json")); // 10-02 capture, after the network was rematched
const pts2 = day2.points.filter((p) => !p.repeat);
const best = pts2.reduce((a, p) => (Math.hypot(p.g.re, p.g.im) < Math.hypot(a.g.re, a.g.im) ? p : a)); // what a hand match reads
const medMiss = (fit: ReturnType<typeof parseMap>["fit"]) => {
  const m = pts2.filter((p) => p !== best).map((p) => {
    const z = zOfGamma(p.g), zp = predictZ(fit, p.tune, p.load);
    return Math.hypot(z.re - zp.re, z.im - zp.im);
  }).sort((a, b) => a - b);
  return m[m.length >> 1];
};

test("REAL: one 10-02 reading re-anchors the 10-01 map — shift T −0.8 / L −0.9 %, predictions back to ~1 Ohm", () => {
  const m1 = parseMap(day1);
  const a = solveAnchor(m1.fit, { tune: best.tune, load: best.load }, zOfGamma(best.g));
  assert.ok(Math.abs(a.sT + 0.81) < 0.05 && Math.abs(a.sL + 0.90) < 0.05, `shift ${a.sT}, ${a.sL}`);
  assert.ok(a.residualOhm < 0.01, `residual ${a.residualOhm}`);
  assert.ok(medMiss(m1.fit) > 8, "unanchored, the day-old map is far off");
  const anchored = parseMap(anchorMapText(day1, { tune: best.tune, load: best.load, z: zOfGamma(best.g), at: "2026-10-02T15:35:00Z" }));
  assert.ok(medMiss(anchored.fit) < 1.5, `anchored median miss ${medMiss(anchored.fit)}`);
  assert.ok(Math.abs(anchored.coldMatch.tune - day2.coldMatch.tune) < 0.1 && Math.abs(anchored.coldMatch.load - day2.coldMatch.load) < 0.15,
    `anchored match T${anchored.coldMatch.tune} L${anchored.coldMatch.load} vs measured T${day2.coldMatch.tune} L${day2.coldMatch.load}`);
  assert.ok(anchored.anchor && Math.abs(anchored.anchor.sT + 0.81) < 0.05, "the anchor (and its shift) is kept with the map");
});

test("anchoring at a reading the map already explains gives (almost) no shift", () => {
  const m = parseMap(fx("rematch_1002.json"));
  const z = predictZ(m.fit, 20.3, 11.4);
  const a = solveAnchor(m.fit, { tune: 20.3, load: 11.4 }, z);
  assert.ok(Math.hypot(a.sT, a.sL) < 1e-4, `shift ${a.sT}, ${a.sL}`);
});

test("a reading no shift of the map can produce is refused (the network changed shape: recapture)", () => {
  const m = parseMap(fx("rematch_1002.json"));
  assert.throws(() => solveAnchor(m.fit, { tune: 20, load: 11 }, { re: 2, im: -300 }), AnchorError);
});

test("re-anchoring replaces the previous anchor (it never stacks)", () => {
  const p = { tune: best.tune, load: best.load, z: zOfGamma(best.g), at: "t1" };
  const once = parseMap(anchorMapText(day1, p));
  const twice = parseMap(anchorMapText(anchorMapText(day1, { ...p, at: "t0" }), p));
  assert.ok(Math.abs(once.anchor!.sT - twice.anchor!.sT) < 1e-9 && Math.abs(once.coldMatch.tune - twice.coldMatch.tune) < 1e-9);
});
