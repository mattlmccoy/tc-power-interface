// The in-run aid's one-line guidance, from the locate result and per-cap directions. Kept pure so the
// wording for each case is tested: it must never sound more certain than the result is.

import type { AxisGuide, LocateResult } from "./locate.ts";

export interface AidMessage { tone: "ok" | "info" | "warn"; text: string }

const arrow = (d: AxisGuide["dir"]) => (d === "up" ? "↑" : "↓");
const capText = (name: string, g: AxisGuide) =>
  `${name} ${arrow(g.dir)}${g.amount != null ? ` ${Math.abs(g.amount).toFixed(1)} %` : ""}`;

/** `fwdW` = present forward power (for the worst-case reflected watts after the move). */
export function aidMessage(
  res: LocateResult,
  g: { tune: AxisGuide; load: AxisGuide } | null,
  fwdW: number,
  rfOn: boolean,
): AidMessage {
  if (res.status === "none") {
    return rfOn
      ? { tone: "info", text: "Hold the caps still for ~2 s to take a reading." }
      : { tone: "info", text: "Readings start when RF is on (forward ≥ 10 W)." };
  }
  if (res.status === "nofit") {
    return { tone: "warn", text: "Readings don't fit the cold map — the hot network has changed shape or the match moved beyond the map. Tune by hand; the map can't help here." };
  }
  if (res.edge) {
    return { tone: "warn", text: "Candidates run beyond the calibrated range — the match may have moved further than the map covers. Tune by hand; trust the map only once the shading comes back inside." };
  }
  const moves = g ? [["Tune", g.tune], ["Load", g.load]].filter(([, a]) => (a as AxisGuide).dir === "up" || (a as AxisGuide).dir === "down") as [string, AxisGuide][] : [];
  if (res.status === "spot") {
    if (!moves.length) return { tone: "ok", text: "At the estimated match — hold." };
    const worstW = res.worstGamma ** 2 * fwdW;
    return { tone: "info", text: `${moves.map(([n, a]) => capText(n, a)).join(", ")} — expect ≤ ${worstW.toFixed(1)} W reflected at the present forward power.` };
  }
  const known = moves.length ? ` So far: ${moves.map(([n, a]) => `${n} ${arrow(a.dir)}`).join(", ")}.` : "";
  return { tone: "info", text: `Not enough readings to tell where the match went. Change one cap by one step and hold ~2 s.${known}` };
}
