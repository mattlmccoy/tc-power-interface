// Which power value the cockpit reads for the Requested dial and the ladder step. Pure; tested in
// power.test.ts.

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** The Requested dial: the setpoint the operator last wrote to the generator (backend controller
 *  snapshot `commanded_setpoint_w`), not the unapplied number in the setpoint box. Unknown = null. */
export function requestedW(snap: { commanded_setpoint_w?: number | null } | undefined): number | null {
  const v = snap?.commanded_setpoint_w;
  return fin(v) ? v : null;
}

/** Which power the ladder's current step is read from: the commanded setpoint when known (forward
 *  lags while the generator ramps, and wobbles), else the forward reading. */
export function ladderBase(commandedW: number | null, forwardW: number): number {
  return fin(commandedW) ? commandedW : forwardW;
}
