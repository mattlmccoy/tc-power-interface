// Dashboard entry card for the pre-run VNA auto-tune. Connecting a NanoVNA (Web Serial, Chrome/Edge)
// begins a VNA session — which locks RF on the backend and opens the focused full-screen VNA tune view
// (VnaTuneView). All the tuning happens there; this card is just the entrance. The connection + session
// live in useVna at the App level so they survive the switch to the tune view.

import type { Status } from "../lib/telemetry.ts";
import type { VnaController } from "../hooks/useVna.ts";

export default function VnaPanel({ vna, status }: { vna: VnaController; status: Status | null }) {
  const sessionActive = status?.vna_session?.active ?? vna.connected;

  return (
    <section className="panel vna-panel">
      <h2>VNA auto-tune (pre-run)</h2>
      <div className="banner experimental help-text">
        <strong>Experimental — RF-off coarse match.</strong> Connect a NanoVNA to match the caps to 50 Ω
        at 13.56 MHz before a fire. Connecting <strong>locks RF</strong> and opens the focused VNA tune
        screen; End there unlocks RF. Distinct from the in-run reflected-power tuner.
      </div>

      {!vna.supported && (
        <div className="banner warn">Web Serial is unavailable — use desktop Chrome or Edge.</div>
      )}

      <div className="controls" style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn accent" onClick={() => void vna.connect()} disabled={!vna.supported}>
          Connect NanoVNA
        </button>
        {sessionActive && (
          <button className="btn" onClick={() => void vna.endSession()}>End VNA session</button>
        )}
      </div>
    </section>
  );
}
