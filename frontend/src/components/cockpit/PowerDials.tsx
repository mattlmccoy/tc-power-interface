import { Gauge } from "../Gauge.tsx";

/** Plain readings for the four dials: values only, never handlers, so the replay can reuse it. */
export interface DialValues {
  /** The setpoint we last wrote (live: controller.commanded_setpoint_w; replay: recorded setpoint_w). */
  requested: number | null;
  forward: number | null;
  load: number | null;
  reverse: number | null;
  powerCeil: number;
  fwdCaution: number | null;
  fwdDanger: number | null;
  maxRefl: number;
}

/** The Dashboard's four analog dials with its scales and zones (TelemetryPanel.tsx gauge branch). */
export function PowerDials({ v }: { v: DialValues }) {
  return (
    <div className="gauge-grid">
      <Gauge label="Requested" value={v.requested} max={v.powerCeil} caution={v.fwdCaution} danger={v.fwdDanger} />
      <Gauge label="Forward" value={v.forward} max={v.powerCeil} caution={v.fwdCaution} danger={v.fwdDanger} />
      <Gauge label="Load" value={v.load} max={v.powerCeil} caution={v.fwdCaution} danger={v.fwdDanger} />
      <Gauge label="Reverse" value={v.reverse} max={v.maxRefl} caution={v.maxRefl * 0.5} danger={v.maxRefl * 0.8} />
    </div>
  );
}
