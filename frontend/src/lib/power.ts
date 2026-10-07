// Which power value the Dashboard's Requested tile/dial shows. Pure; tested in power.test.ts.

import type { Status } from "./telemetry.ts";

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** The Requested reading: the setpoint the operator last wrote to the generator (controller snapshot
 *  `last_setpoint_w`, or its `commanded_setpoint_w` alias), not the unapplied number in the setpoint
 *  box. Unknown (fresh connect, link loss, older operator) is null, never 0. */
export function requestedFromStatus(status: Status | null | undefined): number | null {
  const c = status?.controller;
  const v = c?.last_setpoint_w ?? c?.commanded_setpoint_w;
  return fin(v) ? v : null;
}
