import assert from "node:assert/strict";
import { test } from "node:test";

import { ENGAGE_CONFIDENCE } from "./gates.ts";
import { confidenceSentence, SHOW_CONFIDENCE, shadowCard, type Shadow } from "./shadowText.ts";

const base: Shadow = { valid: true, why: null, k_c_per_w: 0.53, tau_s: 208, confidence: 0.76, t_amb_c: 23.8,
  updates: 150, suggest_w: 61.3, plateau_c: 60.9, settle_s: 300, ttt_s: 422, show: true };

test("confidence sentence by band, and learning", () => {
  assert.match(confidenceSentence({ ...base, valid: false, why: "learning" }), /No estimate yet/);
  assert.match(confidenceSentence({ ...base, confidence: 0.2 }), /can't be told apart/);
  assert.match(confidenceSentence({ ...base, confidence: 0.45 }), /indicative/);
  assert.match(confidenceSentence(base), /Good enough/);
});

test("to-temperature mode shows the suggestion and the difference from your power", () => {
  const c = shadowCard("target", base, 71, 55);
  assert.equal(c.label, "Shadow loop suggests");
  assert.equal(c.value, "61 W");
  assert.equal(c.sub, "−10 W vs your 71 W, toward 55 °C");
  assert.equal(c.muted, false);
});

test("ladder/fixed modes show where the part levels off, never a suggestion", () => {
  const c = shadowCard("ladder", base, 71, 55);
  assert.equal(c.label, "At your power the part levels off at");
  assert.equal(c.value, "≈ 61 °C");
  assert.equal(c.sub, "in ≈ 5:00 (within 1 °C)");
});

test("below 30 % confidence the numbers are muted; invalid shows the reason", () => {
  assert.equal(shadowCard("ladder", { ...base, confidence: 0.2, show: false }, 71, 55).muted, true);
  const c = shadowCard("target", { ...base, valid: false, why: "learning", suggest_w: null, plateau_c: null }, 71, 55);
  assert.equal(c.value, "—");
  assert.equal(c.sub, "learning…");
});

test("a non-learning reason is shown verbatim", () => {
  const why = "no consistent first-order fit yet";
  const s = { ...base, valid: false, why, suggest_w: null, plateau_c: null };
  assert.equal(shadowCard("target", s, 71, 55).sub, why);
  assert.equal(shadowCard("ladder", s, 71, 55).sub, why);
});

test("confidence sentence: unknown confidence says so; the bands follow the shared thresholds", () => {
  assert.equal(confidenceSentence({ ...base, confidence: Number.NaN }), "Confidence unknown.");
  assert.equal(confidenceSentence({ ...base, confidence: undefined as unknown as number }), "Confidence unknown.");
  assert.equal(SHOW_CONFIDENCE, 0.3); // backend control/cockpit.py SHOW_CONFIDENCE
  assert.match(confidenceSentence({ ...base, confidence: SHOW_CONFIDENCE }), /indicative/);
  assert.match(confidenceSentence({ ...base, confidence: SHOW_CONFIDENCE - 0.001 }), /can't be told apart/);
  assert.match(confidenceSentence({ ...base, confidence: ENGAGE_CONFIDENCE }), /Good enough/);
  assert.match(confidenceSentence({ ...base, confidence: ENGAGE_CONFIDENCE - 0.001 }), /indicative/);
});

test("valid estimate but no suggestion: say what we are waiting for, muted", () => {
  // temperature unknown (plateau_c null too): waiting for the part temperature
  const noTemp = { ...base, suggest_w: null, plateau_c: null, settle_s: null, ttt_s: null };
  const a = shadowCard("target", noTemp, 71, 55);
  assert.equal(a.value, "—");
  assert.equal(a.sub, "waiting for part temperature");
  assert.equal(a.muted, true);
  // temperature known (plateau present) but the shadow has not stepped yet (e.g. right after a mode switch)
  const a2 = shadowCard("target", { ...base, suggest_w: null }, 71, 55);
  assert.equal(a2.value, "—");
  assert.equal(a2.sub, "waiting for the next 5 s step");
  assert.equal(a2.muted, true);
  const b = shadowCard("ladder", noTemp, 71, 55);
  assert.equal(b.value, "—");
  assert.equal(b.sub, "waiting for part temperature");
  assert.equal(b.muted, true);
});

test("already settled says so; a missing settle time waits rather than showing nothing", () => {
  assert.equal(shadowCard("ladder", { ...base, settle_s: 0 }, 71, 55).sub, "already within 1 °C");
  const c = shadowCard("ladder", { ...base, settle_s: null }, 71, 55);
  assert.equal(c.value, "≈ 61 °C");
  assert.equal(c.sub, "waiting for part temperature");
});

test("unknown power or target never blanks the suggestion", () => {
  const p = shadowCard("target", base, Number.NaN, 55);
  assert.equal(p.value, "61 W");
  assert.equal(p.sub, "your power unknown, toward 55 °C");
  const t = shadowCard("target", base, 71, Number.NaN);
  assert.equal(t.value, "61 W");
  assert.equal(t.sub, "−10 W vs your 71 W, target unknown");
  assert.equal(shadowCard("target", base, Number.NaN, Number.NaN).sub, "your power unknown, target unknown");
});

test("the difference comes from the rounded numbers shown, and zero reads as the same power", () => {
  // 61.4 -> 61 and 71.5 -> 72 (symmetric rounding): shown "−11", not the raw −10.1 rounded to −10
  assert.equal(shadowCard("target", { ...base, suggest_w: 61.4 }, 71.5, 55).sub, "−11 W vs your 72 W, toward 55 °C");
  assert.equal(shadowCard("target", { ...base, suggest_w: 71.4 }, 71, 55).sub, "same as your 71 W, toward 55 °C");
  assert.equal(shadowCard("target", { ...base, suggest_w: 80.2 }, 71, 55).sub, "+9 W vs your 71 W, toward 55 °C");
});
