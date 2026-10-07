// The Closed-loop cockpit (spec §4, mockup v4): header row, the fixed control strip, the run
// timeline, then Thermal · Run mode · Watched ROIs. It never actuates on its own: every power, RF
// and cap action is an operator click on an existing op.* handler, and Engage stays locked (D12).

import { CockpitStrip } from "../components/cockpit/CockpitStrip.tsx";
import { CockpitTimeline } from "../components/cockpit/CockpitTimeline.tsx";
import { ModeChips, RunModeColumn } from "../components/cockpit/RunModeColumn.tsx";
import { ThermalColumn } from "../components/cockpit/ThermalColumn.tsx";
import { WatchColumn } from "../components/cockpit/WatchColumn.tsx";
import type { MatchAid } from "../hooks/useMatchAid.ts";
import type { Operator } from "../hooks/useOperator.ts";
import { mmss } from "../lib/cockpit/format.ts";
import type { CockpitSample } from "../lib/cockpit/history.ts";
import { runStats } from "../lib/cockpit/live.ts";

export function CockpitPage({ op, aid, history }: { op: Operator; aid: MatchAid; history: CockpitSample[] }) {
  const th = op.thermal;
  const run = op.recording?.run ?? null;
  const stats = runStats(history, run);
  const target = op.thermalPlanStatus?.target_c ?? th?.target_c ?? null;
  return (
    <div className="cockpit">
      <div className="ck-head">
        <div className="ck-viewswitch" role="tablist" aria-label="Closed-loop view">
          <button className="on" role="tab" aria-selected>Cockpit</button>
          <button role="tab" aria-selected={false} disabled title="Runs (replay) lands in Task 21">Runs</button>
        </div>
        <ModeChips op={op} />
        <div className="ck-runinfo">
          <span className="ck-ri-run" title={run ?? "not recording"}>Run <b className="mono">{run ?? "not recording"}</b></span>
          <span className="ck-ri-net" title={aid.map?.label ?? "no active match map"}>Network <b>{aid.map?.label ?? "—"}</b></span>
          <span className="ck-ri-num" title={stats ? `since ${stats.since}` : "not recording"}>
            Elapsed <b className="mono">{stats ? mmss(stats.elapsedS) : "—"}</b>
          </span>
          <span className="ck-ri-num" title={stats ? `forward energy since ${stats.since}` : "not recording"}>
            Energy <b className="mono">{stats ? `${stats.energyWh.toFixed(2)} Wh` : "—"}</b>
          </span>
          <span className="ck-ri-since ck-sub">{stats ? `since ${stats.since}` : ""}</span>
        </div>
      </div>
      <CockpitStrip op={op} />
      <CockpitTimeline
        buf={history}
        mode={th?.run_mode?.mode ?? "ladder"}
        shadow={th?.shadow}
        targetC={target}
        watch={(th?.watch ?? []).map((w) => w.name)}
        controlRoi={th?.control_roi ?? null}
      />
      <div className="ck-cols3">
        <ThermalColumn op={op} buf={history} />
        <RunModeColumn op={op} />
        <WatchColumn op={op} aid={aid} />
      </div>
    </div>
  );
}
