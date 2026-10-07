import assert from "node:assert/strict";
import { test } from "node:test";

import { mmss } from "./format.ts";
import { confidenceSentence, shadowCard, type Shadow } from "./shadowText.ts";

const base: Shadow = { valid: true, why: null, k_c_per_w: 0.53, tau_s: 208, confidence: 0.76, t_amb_c: 23.8,
  updates: 150, suggest_w: 61.3, plateau_c: 60.9, settle_s: 300, ttt_s: 422, show: true };

test("mmss", () => {
  assert.equal(mmss(0), "0:00");
  assert.equal(mmss(422), "7:02");
});

test("mmss: negative or non-finite input is unknown, shown as an em dash (never 0:00)", () => {
  assert.equal(mmss(-5), "—");
  assert.equal(mmss(Number.NaN), "—");
  assert.equal(mmss(Number.POSITIVE_INFINITY), "—");
});

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
