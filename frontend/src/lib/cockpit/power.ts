// Which power the cockpit's ladder step is read from. Pure; tested in power.test.ts. The Requested
// dial's value is requestedW in lib/power.ts, shared with the Dashboard.

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** Which power the ladder's current step is read from: the commanded setpoint when known (forward
 *  lags while the generator ramps, and wobbles), else the forward reading. */
export function ladderBase(commandedW: number | null, forwardW: number): number {
  return fin(commandedW) ? commandedW : forwardW;
}
