import assert from "node:assert/strict";
import { test } from "node:test";

import { ENGAGE_CONFIDENCE } from "./gates.ts";
import { confidenceSentence, roomLine, SHOW_CONFIDENCE, shadowCard, type Shadow } from "./shadowText.ts";

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

// Fix 1: honest confidence (backend control/cockpit.py): drifting = K or tau moved > 5 % in 2 min.
test("drifting: say the estimate is still moving and how much, whatever the band", () => {
  const msg = "Still drifting: gain or time constant moved 10 % in the last 2 min. A power step would pin it down.";
  assert.equal(confidenceSentence({ ...base, confidence: 0.48, drifting: true, drift_pct: 10.4 }), msg);
  // a drift-driven low confidence is not the steady-power "can't be told apart" case
  assert.equal(confidenceSentence({ ...base, confidence: 0.0, drifting: true, drift_pct: 62.1 }),
    "Still drifting: gain or time constant moved 62 % in the last 2 min. A power step would pin it down.");
  // not drifting, or an older backend without the fields: the bands as before
  assert.match(confidenceSentence({ ...base, drifting: false, drift_pct: 1.2 }), /Good enough/);
  assert.match(confidenceSentence({ ...base, confidence: 0.45 }), /indicative/);
  // drifting but no number (should not happen): still says drifting, without a made-up figure
  assert.equal(confidenceSentence({ ...base, confidence: 0.4, drifting: true, drift_pct: null }),
    "Still drifting: gain or time constant still moving. A power step would pin it down.");
  // no estimate wins over everything
  assert.match(confidenceSentence({ ...base, valid: false, drifting: true, drift_pct: 10 }), /No estimate yet/);
});

// Fix 2: suggestion pinned at the ceiling because the target needs more than the ceiling.
test("at the ceiling: say what holding the target would need (10-07 run numbers)", () => {
  const today = { ...base, k_c_per_w: 0.53, t_amb_c: 22.8, suggest_w: 200, ceiling_w: 200, needed_w: 305.7 };
  const c = shadowCard("target", today, 30.5, 185);
  assert.equal(c.value, "200 W");
  assert.equal(c.sub, "At the 200 W ceiling — holding 185 °C needs ≈ 306 W");
  // within 0.5 W of the ceiling still counts
  assert.equal(shadowCard("target", { ...today, suggest_w: 199.6 }, 30.5, 185).sub,
    "At the 200 W ceiling — holding 185 °C needs ≈ 306 W");
});

test("not ceiling-limited: the usual difference text", () => {
  const s = { ...base, suggest_w: 200, ceiling_w: 200, needed_w: 180 }; // ceiling only from the rate limit
  assert.equal(shadowCard("target", s, 190, 55).sub, "+10 W vs your 190 W, toward 55 °C");
  const below = { ...base, suggest_w: 150, ceiling_w: 200, needed_w: 306 }; // still ramping up
  assert.equal(shadowCard("target", below, 140, 55).sub, "+10 W vs your 140 W, toward 55 °C");
  const old = { ...base, suggest_w: 200 }; // older backend: no needed_w / ceiling_w
  assert.equal(shadowCard("target", old, 190, 55).sub, "+10 W vs your 190 W, toward 55 °C");
});

test("at the ceiling with the target unknown: names the target as unknown, never NaN", () => {
  const s = { ...base, suggest_w: 200, ceiling_w: 200, needed_w: 306 };
  assert.equal(shadowCard("target", s, 30, Number.NaN).sub, "At the 200 W ceiling — holding the target needs ≈ 306 W");
});

// Room temperature (backend control/cockpit.py `_ambient_block`, control/ambient.py reasons).
const paused = (reason: string, slope: number | null = null): Shadow => ({
  ...base, valid: false, why: "room_unknown", k_c_per_w: null, tau_s: null, confidence: 0, show: false,
  suggest_w: null, plateau_c: null, t_amb_c: null,
  ambient: { t_c: null, source: null, reason, slope_c_per_min: slope, roi: null },
});

test("a paused shadow says why the room temperature is unknown and what to do", () => {
  const cooling = confidenceSentence(paused("part_cooling", -2.04));
  assert.match(cooling, /^Paused this run: the part was still cooling \(−2\.0 °C\/min\) when RF came on/);
  assert.match(cooling, /rest a minute with RF off, or pick a room reference/);
  assert.match(confidenceSentence(paused("part_warming", 1.0)), /still warming \(\+1\.0 °C\/min\)/);
  assert.match(confidenceSentence(paused("rf_recent")), /RF was on in the minute before/);
  assert.match(confidenceSentence(paused("no_history")), /no part reading in the minute before RF on/);
  const card = shadowCard("target", paused("part_cooling", -2.04), 55, 185);
  assert.deepEqual(card, { label: "Shadow loop suggests", value: "—", sub: "paused: room temperature unknown", muted: true });
});

test("the room line names the source, and unknown is never a number", () => {
  const amb = (a: Partial<NonNullable<Shadow["ambient"]>>): Shadow =>
    ({ ...base, ambient: { t_c: null, source: null, reason: null, slope_c_per_min: null, roi: null, ...a } });
  assert.equal(roomLine(amb({ t_c: 22.83, source: "part_at_rest" })), "22.8 °C · part at rest before RF");
  assert.equal(roomLine(amb({ t_c: 23.44, source: "reference", roi: "toroid_D", reason: "part_cooling" })),
    "23.4 °C · reference toroid_D (part was cooling)");
  assert.equal(roomLine(amb({ t_c: 29.11, source: "assumed" })), "29.1 °C · assumed: first reading, not verified");
  assert.equal(roomLine(amb({ reason: "part_cooling" })), "unknown · part was cooling at RF on");
  assert.equal(roomLine(amb({ reason: "rf_recent" })), "unknown · RF was on in the minute before");
  assert.equal(roomLine(amb({ reason: "no_history" })), "unknown · no reading before RF on");
  assert.equal(roomLine({ ...base, ambient: null }), "decided at RF on");
  const { ambient: _drop, ...older } = { ...base, ambient: null }; // operator older than v0.19
  assert.equal(roomLine(older), "23.8 °C");
});

test("review: no generator before RF on, and an assumed room, are named, never shown as sure", () => {
  assert.match(confidenceSentence(paused("rf_unknown")), /no generator connected in the minute before RF on/);
  const amb = { t_c: null, source: null, reason: "rf_unknown", slope_c_per_min: null, roi: null };
  assert.equal(roomLine({ ...base, ambient: amb }), "unknown · no generator reading before RF on");
  const assumed: Shadow = { ...base, ambient: { t_c: 29.1, source: "assumed", reason: null, slope_c_per_min: null, roi: null } };
  assert.match(confidenceSentence(assumed), /^Unverified: this recording predates the room-temperature check/);
});
