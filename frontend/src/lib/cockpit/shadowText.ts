import { mmss } from "./format.ts";
import { ENGAGE_CONFIDENCE } from "./gates.ts";

/** Below this the backend sets `shadow.show` false (backend control/cockpit.py `SHOW_CONFIDENCE`). */
export const SHOW_CONFIDENCE = 0.3;

/** `/api/status → thermal.shadow` (backend control/cockpit.py `_shadow_block`). */
export interface Shadow {
  valid: boolean;
  why: string | null;
  k_c_per_w: number | null;
  tau_s: number | null;
  confidence: number;
  t_amb_c: number | null;
  updates: number;
  suggest_w: number | null;
  plateau_c: number | null;
  settle_s: number | null;
  ttt_s: number | null;
  show: boolean;
}

export type RunModeName = "ladder" | "fixed" | "target";

/** Round half away from zero (JS Math.round sends -2.5 to -2 but 2.5 to 3). */
function round(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

export function confidenceSentence(s: Shadow): string {
  if (!s.valid) return "No estimate yet, so no suggestion.";
  if (!fin(s.confidence)) return "Confidence unknown.";
  if (s.confidence < SHOW_CONFIDENCE) return "Low: at steady power the gain and time constant can't be told apart. A power step sharpens it.";
  if (s.confidence < ENGAGE_CONFIDENCE) return "Firming up: treat the numbers as indicative.";
  return "Good enough to compare with what you're doing.";
}

export interface ShadowCardText {
  label: string;
  value: string;
  sub: string;
  muted: boolean;
}

const WAIT_TEMP = "waiting for part temperature";
const WAIT_STEP = "waiting for the next 5 s step";

/**
 * Text for the shadow card. Backend facts this relies on (control/cockpit.py `_shadow_block`):
 * `plateau_c`/`settle_s` are null while the part temperature is unknown; `suggest_w` is null
 * outside to-temperature mode, on an unknown temperature, and until the first 5 s step after a
 * mode switch or run reset. So a VALID estimate with no number is "waiting", never a silent dash:
 * for the suggestion, plateau_c null means the temperature is the missing piece, otherwise the
 * next step is. A missing value mutes the card. Unknown `yourW`/`targetC` never blank the
 * suggestion; they are named as unknown.
 */
export function shadowCard(mode: RunModeName, s: Shadow, yourW: number, targetC: number): ShadowCardText {
  const muted = !s.show;
  const why = s.why === "learning" ? "learning…" : s.why ?? "";
  if (mode === "target") {
    const label = "Shadow loop suggests";
    if (!s.valid) return { label, value: "—", sub: why, muted };
    if (!fin(s.suggest_w)) return { label, value: "—", sub: fin(s.plateau_c) ? WAIT_STEP : WAIT_TEMP, muted: true };
    const shown = round(s.suggest_w);
    const d = fin(yourW) ? shown - round(yourW) : null;
    const target = fin(targetC) ? `toward ${targetC} °C` : "target unknown";
    let sub: string;
    if (d === null) sub = `your power unknown, ${target}`;
    else if (d === 0) sub = fin(targetC) ? `on target: same as your ${round(yourW)} W` : `same as your ${round(yourW)} W, target unknown`;
    else sub = `${d > 0 ? "+" : "−"}${Math.abs(d)} W vs your ${round(yourW)} W, ${target}`;
    return { label, value: `${shown} W`, sub, muted };
  }
  const label = "At your power the part levels off at";
  if (!s.valid) return { label, value: "—", sub: why, muted };
  if (!fin(s.plateau_c)) return { label, value: "—", sub: WAIT_TEMP, muted: true };
  const settle = !fin(s.settle_s) ? WAIT_TEMP : s.settle_s === 0 ? "already within 1 °C" : `in ≈ ${mmss(s.settle_s)} (within 1 °C)`;
  return { label, value: `≈ ${round(s.plateau_c)} °C`, sub: settle, muted };
}
