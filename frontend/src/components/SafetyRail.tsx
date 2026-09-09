// Always-visible safe-direction controls, rendered on EVERY page under the topbar. The safe actions
// (E-STOP, RF OFF, device DISARM) are never hidden behind a tab. The hero keeps its own DISARM LOOP.

interface SafetyRailProps {
  connected: boolean;
  armed: boolean;
  estop: () => void;
  rfOff: () => void;
  disarmDevice: () => void;
}

export function SafetyRail({ connected, armed, estop, rfOff, disarmDevice }: SafetyRailProps) {
  return (
    <div className="safety-rail" role="toolbar" aria-label="safety controls">
      <button
        className="btn estop"
        onClick={estop}
        disabled={!connected}
        title="Emergency stop: RF off, setpoint 0, all drivers halted"
      >
        ⏻ E-STOP
      </button>
      <button className="btn" onClick={rfOff} disabled={!connected}>
        RF OFF
      </button>
      <button
        className="btn"
        onClick={disarmDevice}
        disabled={!connected || !armed}
        title="Drop control: RF off, back to read-only"
      >
        DISARM
      </button>
    </div>
  );
}
