// RF on-time clock for the top bar: current burn (or last burn) and RF-on total in the recording.
import { rfClockView } from "../lib/heartbeat.ts";
import type { RfClockBlock } from "../lib/heartbeat.ts";

export function RfClock({ clock, appAlive }: { clock: RfClockBlock | null | undefined; appAlive: boolean }) {
  const v = rfClockView(clock, appAlive);
  if (!v) return null;
  return (
    <span
      className={`rfclock rfclock-${v.tone}`}
      title="RF on-time: current continuous burn (or the last one) · RF-on total in this recording"
    >
      {v.text}
    </span>
  );
}
