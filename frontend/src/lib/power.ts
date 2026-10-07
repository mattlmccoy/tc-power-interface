// The Requested power reading shared by the Dashboard and the cockpit. Pure; tested in power.test.ts.

import type { Snapshot } from "./telemetry.ts";

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** The Requested reading: the setpoint the operator last wrote to the generator, not the unapplied
 *  number in the setpoint box. Reads the controller snapshot's `commanded_setpoint_w` (v0.18+), or
 *  `last_setpoint_w` from an older operator (the backend sends both with the same value). Unknown
 *  (fresh connect, link loss) is null, never 0. */
export function requestedW(
  snap: Pick<Snapshot, "commanded_setpoint_w" | "last_setpoint_w"> | null | undefined,
): number | null {
  const v = snap?.commanded_setpoint_w ?? snap?.last_setpoint_w;
  return fin(v) ? v : null;
}
