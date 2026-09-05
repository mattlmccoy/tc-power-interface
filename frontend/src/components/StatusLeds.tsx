import { statusLeds } from "../lib/instrument.ts";

/** CXN-style status-LED strip (RF on, forward/reverse limit, overheat, interlock). */
export function StatusLeds({ status }: { status: number | null }) {
  const leds = statusLeds(status ?? 0);
  return (
    <div className="led-strip">
      {leds.map((led) => (
        <div key={led.label} className={`led-item ${status === null ? "led-unknown" : ""}`}>
          <span className={`led led-${led.tone}`} />
          <span className="led-label">{led.label}</span>
        </div>
      ))}
    </div>
  );
}
