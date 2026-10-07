// Watched ROIs + drift (spec §4, D3): transformer cores and other ROIs, display and warn only. The
// real interlock is a separate build. Picking ROIs saves the list (api.setWatch); nothing actuates.

import type { Operator } from "../../hooks/useOperator.ts";
import type { MatchAid } from "../../hooks/useMatchAid.ts";
import { api, detail } from "../../lib/api.ts";
import { f1 } from "../../lib/cockpit/format.ts";
import { coreLevel } from "../../lib/cockpit/ladder.ts";
import { MAX_WATCH, toggleWatch, WATCH_DEFAULTS } from "../../lib/cockpit/live.ts";
import { DriftBlock } from "../MatchAidPanel.tsx";
import { WATCH_COLORS } from "./drawTimeline.ts";

const STATUS_WORD: Record<string, string> = { not_in_feed: "not in feed", invalid: "invalid reading" };

export function WatchColumn({ op, aid }: { op: Operator; aid: MatchAid }) {
  const th = op.thermal;
  const watch = th?.watch ?? [];
  const names = watch.map((w) => w.name);
  const ctl = th?.control_roi ?? null;
  const pickable = (th?.available_rois ?? []).filter((r) => r !== ctl);
  async function change(name: string, on: boolean) {
    const next = toggleWatch(names, name, on, ctl);
    if (next === names) return;
    try {
      const res = await api.setWatch(next);
      if (!res.ok) op.flash(`watch: ${await detail(res)}`);
    } catch {
      op.flash("watch: could not reach the operator");
    }
  }
  return (
    <section className="panel" aria-label="Watched ROIs and drift">
      <h2>
        <span>Watched ROIs</span>
        <span className="mono">display + warn only</span>
      </h2>
      <div className="ck-watchrows">
        {watch.length ? (
          watch.map((w, k) => {
            const lvl = w.status === "ok" ? coreLevel(w.temp_c, w.rate_c_per_min, WATCH_DEFAULTS) : "unknown";
            const cls = lvl === "warn" ? "ck-warnc" : lvl === "unknown" ? "ck-muted" : "";
            return (
              <div className="ck-coreRow" key={w.name}>
                <span className="ck-corename" title={w.name}>
                  <span className={`ck-sw${k ? " dash" : ""}`} style={k ? { color: WATCH_COLORS[k] } : { background: WATCH_COLORS[0] }} />
                  {w.name}
                </span>
                <span className={`mono ${cls}`}>{w.status === "ok" ? `${f1(w.temp_c)} °C` : STATUS_WORD[w.status] ?? w.status}</span>
                <span className={`mono ck-sub ${cls}`}>
                  {w.rate_c_per_min == null ? (w.status === "ok" ? "rate after 60 s" : "") : `${w.rate_c_per_min >= 0 ? "+" : ""}${w.rate_c_per_min.toFixed(1)} °C/min`}
                </span>
              </div>
            );
          })
        ) : (
          <div className="ck-sub">Nothing watched. Pick up to {MAX_WATCH} below.</div>
        )}
      </div>
      <div className="ck-watchpick" aria-label="Choose ROIs to watch">
        {pickable.length ? (
          pickable.map((r) => {
            const on = names.includes(r);
            return (
              <label key={r} className={on ? "on" : ""}>
                <input type="checkbox" checked={on} disabled={!on && names.length >= MAX_WATCH} onChange={(e) => void change(r, e.target.checked)} />
                {r}
              </label>
            );
          })
        ) : (
          <span className="ck-sub">No live FLIR ROIs to pick from.</span>
        )}
      </div>
      <div className="ck-sub" style={{ marginTop: 4 }}>
        Warn ≥ {WATCH_DEFAULTS.tempC} °C or ≥ {WATCH_DEFAULTS.ratePerMin} °C/min
        {WATCH_DEFAULTS.provisional ? " — provisional, to be set from run data." : "."}
      </div>
      <div className="ck-section">
        <DriftBlock d={aid.drift} fwd={op.t?.forward_w ?? 0} reset={aid.resetDrift} />
      </div>
    </section>
  );
}
