import type { Operator } from "../../hooks/useOperator.ts";
import { Gauge } from "../Gauge.tsx";

/** The Dashboard's four analog dials with exactly its props (TelemetryPanel.tsx gauge branch). */
export function PowerDials({ op }: { op: Operator }) {
  const t = op.t;
  return (
    <div className="gauge-grid">
      <Gauge label="Requested" value={op.requested} max={op.powerCeil} caution={op.fwdCaution} danger={op.fwdDanger} />
      <Gauge label="Forward" value={t ? t.forward_w : null} max={op.powerCeil} caution={op.fwdCaution} danger={op.fwdDanger} />
      <Gauge label="Load" value={t ? t.load_w : null} max={op.powerCeil} caution={op.fwdCaution} danger={op.fwdDanger} />
      <Gauge label="Reverse" value={t ? t.reverse_w : null} max={op.maxRefl} caution={op.maxRefl * 0.5} danger={op.maxRefl * 0.8} />
    </div>
  );
}
