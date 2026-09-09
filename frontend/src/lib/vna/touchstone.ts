// Minimal Touchstone (.s1p) reader for tests and fixture loading. Reads the "# Hz S RI R 50"
// format the bench NanoVNA captures use: each data row is "frequency_hz s11_re s11_im". This is a
// one-port reader (S11 only); s21 is filled with zero so the rows satisfy the vendored SweepPoint
// shape. It is NOT vendored from nanovna-web — see PROVENANCE.md.

import type { SweepPoint } from "./rf.ts";

/** Parse Touchstone text (`# Hz S RI R 50`, one-port) into S11 sweep points. Comment (`!`) and
 *  option (`#`) lines are skipped; malformed/non-finite rows are dropped. */
export function parseTouchstone(text: string): SweepPoint[] {
  const points: SweepPoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) continue;
    const [frequency, re, im] = parts;
    points.push({ frequency, s11: { re, im }, s21: { re: 0, im: 0 } });
  }
  return points;
}
