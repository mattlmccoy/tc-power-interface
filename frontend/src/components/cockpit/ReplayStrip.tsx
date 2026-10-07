// The control strip in replay: the same three panels and heights as CockpitStrip, showing the
// recorded values at the cursor. Read-only by construction: it takes plain numbers, never an
// operator object or a handler, and renders no buttons or inputs (spec §6 "Read-only").

import type { ReplayRow } from "../../lib/cockpit/replay.ts";
import { matchStatus } from "../../lib/cockpit/live.ts";
import { DialNote } from "./CockpitStrip.tsx";
import { PowerDials } from "./PowerDials.tsx";

export interface ReplayScales {
  powerCeil: number;
  fwdCaution: number | null;
  fwdDanger: number | null;
  maxRefl: number;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

function CapReadout({ name, value }: { name: string; value: number | null }) {
  return (
    <div className="ck-cap">
      <span className="ck-cap-lbl">{name}</span>
      <span className="ck-cap-ph" aria-hidden />
      <span className="ck-cap-v">{fin(value) ? value.toFixed(1) : "—"}<small>%</small></span>
      <span className="ck-cap-ph" aria-hidden />
    </div>
  );
}

export function ReplayStrip({ row, scales }: { row: ReplayRow | null; scales: ReplayScales }) {
  const rf = row?.rf_on;
  const m = row ? matchStatus({ rf_on: row.rf_on, forward_w: row.forward_w ?? Number.NaN, reverse_w: row.reverse_w ?? Number.NaN }) : matchStatus(null);
  return (
    <div className="ck-strip ro" aria-label="Recorded values at the cursor (read-only)">
      <section className="panel ck-meters" aria-label="Power meters at the cursor">
        <h2>
          <span>Power · at cursor</span>
          <span className={rf ? "ck-ok" : "ck-muted"}>{row == null ? "RF —" : rf ? "RF ON" : "RF OFF"}</span>
        </h2>
        <PowerDials
          v={{
            requested: row?.setpoint_w ?? null,
            forward: row?.forward_w ?? null,
            load: row?.load_w ?? null,
            reverse: row?.reverse_w ?? null,
            ...scales,
          }}
        />
        <DialNote {...scales} />
      </section>
      <section className="panel ck-sp" aria-label="Recorded setpoint">
        <h2>
          <span>Setpoint · recorded</span>
          <span className="ck-robadge">read-only</span>
        </h2>
        <div className="ck-spbody">
          <div className="field-label">Setpoint sent (W)</div>
          <div className="ck-rovalue">{fin(row?.setpoint_w) ? row!.setpoint_w!.toFixed(0) : "—"}<small> W</small></div>
          <div className="ck-sub">
            {row == null ? "No row at the cursor." : row.setpoint_w == null ? "Not recorded at this point (before 2026-10-07, after a link loss, or set on the front panel)." : ""}
          </div>
          <div className="ck-sub ck-ronote">Replay: nothing on this page sends a command. Power, RF and the caps are readouts here.</div>
        </div>
      </section>
      <section className="panel ck-match" aria-label="Recorded match">
        <h2>
          <span>Match · at cursor</span>
          <span className={`ck-reflchip ck-${m.tone}`}>{m.chip}</span>
        </h2>
        <CapReadout name="Tune" value={row?.tune ?? null} />
        <CapReadout name="Load" value={row?.load ?? null} />
        <div className={`ck-matchline ck-${m.tone}`}>{m.text}</div>
      </section>
    </div>
  );
}
