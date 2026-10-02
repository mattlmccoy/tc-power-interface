// REAL-run regression for the in-run aid: 2026-10-02 FULL_SWEEP (ladder 5 → 70 W) with the map that was
// active (2026-10-02 rematch). Tune had to go DOWN at every retune (19.8 → ~13 %). v0.12.1 replayed this
// and advised "Tune ↑ 0.3-0.4 %" right after each correct downward retune (estimates built from 0.0 W
// readings, biased toward the map's calibrated area). That must never happen again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMap } from "./store.ts";
import { emptyTrack, trackSample, type TelSample } from "./track.ts";
import { locateMatch, guide } from "./locate.ts";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const map = parseMap(fx("rematch_1002.json"));
const samples: TelSample[] = JSON.parse(fx("fullsweep_1002.json")).samples;

test("REAL 2026-10-02 full sweep: no move advice while matched; Tune ↑ only for the real overshoot", () => {
  let st = emptyTrack();
  const adviceWhileMatched: string[] = [];
  const ups: Array<{ t: number; tune: number; rev: number }> = [];
  let matched = 0;
  for (const s of samples) {
    st = trackSample(st, s);
    const res = locateMatch(map.fit, map.coldMatch, st.readings);
    if (res.status === "matched") matched++;
    const g = guide(res, { tune: s.tune as number, load: s.load as number });
    const moving = (d: string) => d === "up" || d === "down";
    if (s.rfOn && s.fwd >= 10 && s.rev / s.fwd <= 0.0025 && (moving(g.tune.dir) || moving(g.load.dir))) {
      adviceWhileMatched.push(`${(s.tMs / 1000).toFixed(0)}s T${s.tune} rev ${s.rev} (${res.status})`);
    }
    if (g.tune.dir === "up") ups.push({ t: s.tMs / 1000, tune: s.tune as number, rev: s.rev });
  }
  assert.deepEqual(adviceWhileMatched, []); // v0.12.1 said "Tune ↑ 0.3-0.4 %" here, after each correct retune
  assert.ok(matched > 300, `matched samples ${matched}`);
  // The only Tune-up advice: 754-758 s, when the operator overshot DOWN to T12.8-13.2 and reflected rose
  // to 1.1-1.8 W; the run confirms it was right (back at T14.2-14.8 reflected fell to 0.0-0.5 W).
  for (const u of ups) assert.ok(u.t >= 750 && u.t <= 760 && u.tune <= 13.3 && u.rev >= 1.0, JSON.stringify(u));
});
