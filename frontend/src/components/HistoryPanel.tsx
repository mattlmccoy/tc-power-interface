import type { Point } from "../lib/telemetry.ts";
import { TimePlot } from "./TimePlot.tsx";

const REFLECT_PLOT_CEIL = 15; // history-plot reflected % y-scale

interface HistoryPanelProps {
  plot: { fwd: Point[]; refl: Point[] };
  powerCeil: number;
}

export function HistoryPanel({ plot, powerCeil }: HistoryPanelProps) {
  return (
    <section className="panel">
      <h2>History</h2>
      <TimePlot
        forward={plot.fwd}
        reflectedPct={plot.refl}
        powerCeil={powerCeil}
        reflectCeil={REFLECT_PLOT_CEIL}
      />
      <div className="plot-legend">
        <span>
          <span className="swatch fwd" />
          forward power (0–{powerCeil} W)
        </span>
        <span>
          <span className="swatch refl" />
          reverse (0–{REFLECT_PLOT_CEIL}%)
        </span>
      </div>
    </section>
  );
}
