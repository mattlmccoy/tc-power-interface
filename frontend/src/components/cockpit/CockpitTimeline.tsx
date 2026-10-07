// The full-width run timeline (spec §4): temperature lane over a power lane, last 15 min or the
// whole buffer. Fixed canvas height and a reserved legend height, so data arriving never moves the
// layout (D9). Display only. In replay (`replay` set) it shows the whole recording, greys the future
// past the cursor and draws both the target and the levels-off line at the cursor.

import { useEffect, useMemo, useRef, useState } from "react";

import { mmss } from "../../lib/cockpit/format.ts";
import type { CockpitSample } from "../../lib/cockpit/history.ts";
import { retuneNs } from "../../lib/cockpit/live.ts";
import { plateauForAxis } from "../../lib/cockpit/plotPrep.ts";
import type { Shadow } from "../../lib/cockpit/shadowText.ts";
import { showLevelsOffLine, type WindowMode } from "../../lib/cockpit/timeline.ts";
import { drawTimeline, WATCH_COLORS } from "./drawTimeline.ts";

export interface TimelineReplay {
  /** Cursor, seconds from the run start. */
  cursorS: number;
  /** Levels-off plateau at the cursor (shown at ≥ 30 % confidence), or null. */
  plateauC: number | null;
  /** Part temperature at the cursor (judges whether the plateau is plausible enough to plot). */
  partC: number | null;
}

interface Props {
  buf: CockpitSample[];
  mode: string;
  shadow: Shadow | undefined;
  targetC: number | null;
  watch: string[];
  controlRoi: string | null;
  replay?: TimelineReplay;
}

const Sw = ({ color, dash }: { color: string; dash?: boolean }) => (
  <span className={`ck-sw${dash ? " dash" : ""}`} style={dash ? { color } : { background: color }} />
);

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

export function CockpitTimeline({ buf, mode, shadow, targetC, watch, controlRoi, replay }: Props) {
  const [win, setWin] = useState<WindowMode>("15");
  const cv = useRef<HTMLCanvasElement>(null);
  const retunes = useMemo(() => retuneNs(buf), [buf]);
  const hlines: { c: number; kind: "target" | "plateau" }[] = [];
  let showSuggest: boolean;
  if (replay) {
    if (fin(targetC)) hlines.push({ c: targetC, kind: "target" });
    const p = plateauForAxis(replay.plateauC, replay.partC, targetC);
    if (p !== null) hlines.push({ c: p, kind: "plateau" });
    showSuggest = true; // replay samples carry the suggestion only where confidence ≥ 30 %
  } else {
    if (mode === "target" && fin(targetC)) hlines.push({ c: targetC, kind: "target" });
    else if (shadow && showLevelsOffLine(mode, shadow)) {
      const p = plateauForAxis(shadow.plateau_c, buf.length ? buf[buf.length - 1].part : null, targetC);
      if (p !== null) hlines.push({ c: p, kind: "plateau" }); // a wild fit is not plotted (it would squash the lane)
    }
    showSuggest = mode === "target" && !!shadow?.show;
  }
  const hkey = hlines.map((h) => `${h.kind}${h.c}`).join("|");
  const cursorNs = replay ? Math.round(replay.cursorS * 1e9) : null;

  // One paint per data change; the ResizeObserver (created once) repaints with the LATEST inputs
  // through the ref, so a new sample neither paints twice nor re-creates the observer.
  const paintRef = useRef<() => void>(() => {});
  paintRef.current = () => {
    if (cv.current) drawTimeline(cv.current, { buf, win, watch, hlines, showSuggest, retunes, cursorNs });
  };
  useEffect(() => {
    paintRef.current();
    // hlines is rebuilt each render; hkey carries its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf, win, watch.join("|"), hkey, showSuggest, retunes, cursorNs]);
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const ro = new ResizeObserver(() => paintRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const targetMode = replay ? true : mode === "target";
  return (
    <section className="panel ck-timeline timeline" aria-label="Run timeline">
      <h2>
        <span>{replay ? "Run timeline · replay" : "Run timeline"}</span>
        {replay ? (
          <span className="mono ck-cursortxt">cursor {mmss(replay.cursorS)}</span>
        ) : (
          <span className="seg" role="tablist" aria-label="Timeline window">
            <button className={`seg-btn ${win === "15" ? "on" : ""}`} role="tab" aria-selected={win === "15"} onClick={() => setWin("15")}>
              Last 15 min
            </button>
            <button className={`seg-btn ${win === "all" ? "on" : ""}`} role="tab" aria-selected={win === "all"} onClick={() => setWin("all")}>
              Whole run (since page opened or run start)
            </button>
          </span>
        )}
      </h2>
      <canvas ref={cv} className="ck-canvas" />
      <div className="ck-legend">
        <span><Sw color="var(--accent)" />Part · {controlRoi ?? "no control ROI"}</span>
        {watch.map((w, k) => (
          <span key={w}><Sw color={WATCH_COLORS[k % 4]} dash={k > 0} />{w}</span>
        ))}
        {targetMode && <span><Sw color="var(--live)" dash />Target</span>}
        {(!targetMode || replay) && (
          <span><Sw color="var(--ck-shadow)" dash />Levels off{replay ? " at the cursor" : ""} (shown at confidence ≥ 30 %)</span>
        )}
        <span><Sw color="var(--trace-fwd)" />Your forward W</span>
        {targetMode && <span><Sw color="var(--ck-shadow)" dash />Shadow suggestion (confidence ≥ 30 %)</span>}
        <span><Sw color="var(--trace-refl)" />Reflected % (right)</span>
        <span><span className="ck-sw ck-tick" />Retune</span>
      </div>
    </section>
  );
}
