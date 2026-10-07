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
  /** Honest confidence: the fit confidence capped by how far K/τ moved in the last 2 min. */
  confidence: number;
  /** The raw RLS fit confidence (absent on operators older than v0.18.4). */
  confidence_fit?: number | null;
  /** Largest relative move of K or τ over the last 2 min, in %; null = not known yet. */
  drift_pct?: number | null;
  /** drift_pct > 5 %. */
  drifting?: boolean;
  /** To-temperature mode: steady power that holds the target, (target − T_amb)/K; else null. */
  needed_w?: number | null;
  /** The power ceiling the shadow loop was clamped to. */
  ceiling_w?: number | null;
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
  if (s.drifting) {
    const moved = fin(s.drift_pct) ? `moved ${round(s.drift_pct)} % in the last 2 min` : "still moving";
    return `Still drifting: gain or time constant ${moved}. A power step would pin it down.`;
  }
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
    if (fin(s.ceiling_w) && fin(s.needed_w) && s.suggest_w >= s.ceiling_w - 0.5 && s.needed_w > s.ceiling_w) {
      const hold = fin(targetC) ? `holding ${targetC} °C` : "holding the target";
      return { label, value: `${shown} W`, sub: `At the ${round(s.ceiling_w)} W ceiling — ${hold} needs ≈ ${round(s.needed_w)} W`, muted };
    }
    const d = fin(yourW) ? shown - round(yourW) : null;
    const target = fin(targetC) ? `toward ${targetC} °C` : "target unknown";
    let sub: string;
    if (d === null) sub = `your power unknown, ${target}`;
    else if (d === 0) sub = `same as your ${round(yourW)} W, ${target}`; // about power, not temperature
    else sub = `${d > 0 ? "+" : "−"}${Math.abs(d)} W vs your ${round(yourW)} W, ${target}`;
    return { label, value: `${shown} W`, sub, muted };
  }
  const label = "At your power the part levels off at";
  if (!s.valid) return { label, value: "—", sub: why, muted };
  if (!fin(s.plateau_c)) return { label, value: "—", sub: WAIT_TEMP, muted: true };
  const settle = !fin(s.settle_s) ? WAIT_TEMP : s.settle_s === 0 ? "already within 1 °C" : `in ≈ ${mmss(s.settle_s)} (within 1 °C)`;
  return { label, value: `≈ ${round(s.plateau_c)} °C`, sub: settle, muted };
}
