// The full-width run timeline (spec §4): temperature lane over a power lane, last 15 min or the
// whole buffer. Fixed canvas height and a reserved legend height, so data arriving never moves the
// layout (D9). Display only.

import { useEffect, useMemo, useRef, useState } from "react";

import type { CockpitSample } from "../../lib/cockpit/history.ts";
import { retuneNs } from "../../lib/cockpit/live.ts";
import type { Shadow } from "../../lib/cockpit/shadowText.ts";
import { showLevelsOffLine, type WindowMode } from "../../lib/cockpit/timeline.ts";
import { drawTimeline, WATCH_COLORS } from "./drawTimeline.ts";

interface Props {
  buf: CockpitSample[];
  mode: string;
  shadow: Shadow | undefined;
  targetC: number | null;
  watch: string[];
  controlRoi: string | null;
}

const Sw = ({ color, dash }: { color: string; dash?: boolean }) => (
  <span className={`ck-sw${dash ? " dash" : ""}`} style={dash ? { color } : { background: color }} />
);

export function CockpitTimeline({ buf, mode, shadow, targetC, watch, controlRoi }: Props) {
  const [win, setWin] = useState<WindowMode>("15");
  const cv = useRef<HTMLCanvasElement>(null);
  const retunes = useMemo(() => retuneNs(buf), [buf]);
  const target = mode === "target" && targetC != null && Number.isFinite(targetC);
  const plateau = !target && shadow && showLevelsOffLine(mode, shadow) ? shadow.plateau_c : null;
  const hline = target ? { c: targetC!, kind: "target" as const } : plateau != null ? { c: plateau, kind: "plateau" as const } : null;
  const showSuggest = mode === "target" && !!shadow?.show;

  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const paint = () => drawTimeline(el, { buf, win, watch, hline, showSuggest, retunes });
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(el);
    return () => ro.disconnect();
    // hline is rebuilt each render; its fields are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf, win, watch.join("|"), hline?.c, hline?.kind, showSuggest, retunes]);

  return (
    <section className="panel ck-timeline timeline" aria-label="Run timeline">
      <h2>
        <span>Run timeline</span>
        <span className="seg" role="tablist" aria-label="Timeline window">
          <button className={`seg-btn ${win === "15" ? "on" : ""}`} role="tab" aria-selected={win === "15"} onClick={() => setWin("15")}>
            Last 15 min
          </button>
          <button className={`seg-btn ${win === "all" ? "on" : ""}`} role="tab" aria-selected={win === "all"} onClick={() => setWin("all")}>
            Whole run (since page opened or run start)
          </button>
        </span>
      </h2>
      <canvas ref={cv} className="ck-canvas" />
      <div className="ck-legend">
        <span><Sw color="var(--accent)" />Part · {controlRoi ?? "no control ROI"}</span>
        {watch.map((w, k) => (
          <span key={w}><Sw color={WATCH_COLORS[k % 4]} dash={k > 0} />{w}</span>
        ))}
        {mode === "target" ? (
          <span><Sw color="var(--live)" dash />Target</span>
        ) : (
          <span><Sw color="var(--ck-shadow)" dash />Levels off (shown at confidence ≥ 30 %)</span>
        )}
        <span><Sw color="var(--trace-fwd)" />Your forward W</span>
        {mode === "target" && <span><Sw color="var(--ck-shadow)" dash />Shadow suggestion (confidence ≥ 30 %)</span>}
        <span><Sw color="var(--trace-refl)" />Reflected % (right)</span>
        <span><span className="ck-sw ck-tick" />Retune</span>
      </div>
    </section>
  );
}
