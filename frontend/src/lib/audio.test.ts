import assert from "node:assert/strict";
import { test } from "node:test";

import { ALERT_TONES, CLOCK_TONES, type Tone } from "./audio.ts";

// 2026-11-18: the run clock reused the reflected-power warning chime and scared Matt mid-run. The
// clock is a friendly reminder; it must NEVER sound like a hardware warning.
const alertTones: Tone[] = [...ALERT_TONES.chime, ...ALERT_TONES.alarm];
const clockTones: Tone[] = [...CLOCK_TONES.warn, ...CLOCK_TONES.final, ...CLOCK_TONES.over];
const SEMITONE = 2 ** (1 / 12);

test("clock tones share no pitch (within a semitone) with any alert sound", () => {
  for (const c of clockTones) {
    for (const a of alertTones) {
      const ratio = Math.max(c.freq, a.freq) / Math.min(c.freq, a.freq);
      assert.ok(ratio >= SEMITONE, `clock ${c.freq} Hz is within a semitone of alert ${a.freq} Hz`);
    }
  }
});

// "it needs to be a MUCH gentler tone" (Matt, 2026-11-18): pure sine bells, quiet, a soft fade-in
// and a long fade-out; nothing buzzy (no square / sawtooth / triangle edges).
test("clock tones are gentle: pure sine, quiet, soft onset, long fade", () => {
  const chimeGain = Math.max(...ALERT_TONES.chime.map((t) => t.gain));
  for (const c of clockTones) {
    assert.equal(c.type, "sine", `clock waveform ${c.type}`);
    assert.ok(c.gain <= 0.35 * chimeGain, `clock gain ${c.gain} is not much softer than ${chimeGain}`);
    assert.ok((c.attack ?? 0) >= 0.04, `clock attack ${c.attack} is too abrupt`);
    assert.ok(c.dur >= 0.8, `clock note ${c.dur} s fades too fast`);
  }
});

test("the three clock cues sound different from each other", () => {
  const sig = (ts: Tone[]) => ts.map((t) => `${t.freq}@${t.start}`).join(",");
  const sigs = [sig(CLOCK_TONES.warn), sig(CLOCK_TONES.final), sig(CLOCK_TONES.over)];
  assert.equal(new Set(sigs).size, 3);
});
