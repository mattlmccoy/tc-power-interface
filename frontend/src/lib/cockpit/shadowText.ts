import { mmss } from "./format.ts";

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

export function confidenceSentence(s: Shadow): string {
  if (!s.valid) return "No estimate yet, so no suggestion.";
  if (s.confidence < 0.3) return "Low: at steady power the gain and time constant can't be told apart. A power step sharpens it.";
  if (s.confidence < 0.6) return "Firming up: treat the numbers as indicative.";
  return "Good enough to compare with what you're doing.";
}

export interface ShadowCardText {
  label: string;
  value: string;
  sub: string;
  muted: boolean;
}

export function shadowCard(mode: RunModeName, s: Shadow, yourW: number, targetC: number): ShadowCardText {
  const muted = !s.show;
  const why = s.why === "learning" ? "learning…" : s.why ?? "";
  if (mode === "target") {
    if (!s.valid || s.suggest_w == null) return { label: "Shadow loop suggests", value: "—", sub: why, muted };
    const d = Math.round(s.suggest_w - yourW);
    return {
      label: "Shadow loop suggests",
      value: `${Math.round(s.suggest_w)} W`,
      sub: `${d >= 0 ? "+" : "−"}${Math.abs(d)} W vs your ${Math.round(yourW)} W, toward ${targetC} °C`,
      muted,
    };
  }
  const label = "At your power the part levels off at";
  if (!s.valid || s.plateau_c == null) return { label, value: "—", sub: why, muted };
  const settle = s.settle_s == null ? "" : s.settle_s === 0 ? "now" : `in ≈ ${mmss(s.settle_s)} (within 1 °C)`;
  return { label, value: `≈ ${Math.round(s.plateau_c)} °C`, sub: settle, muted };
}
