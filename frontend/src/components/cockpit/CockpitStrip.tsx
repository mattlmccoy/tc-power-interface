// The cockpit's fixed control strip (spec §4, D6/D10): analog power dials · setpoint (Manual | Temp
// loop) · manual Tune/Load. Every action here is an operator click wired to an EXISTING op.* handler;
// nothing actuates on its own. Fixed heights throughout so nothing in a run moves the layout (D9).

import { useState } from "react";

import type { Operator } from "../../hooks/useOperator.ts";
import { api, detail } from "../../lib/api.ts";
import { engageAllowed, loopGates } from "../../lib/cockpit/gates.ts";
import { matchStatus } from "../../lib/cockpit/live.ts";
import { requestedW } from "../../lib/cockpit/power.ts";
import { DialNote } from "./DialNote.tsx";
import { PowerDials } from "./PowerDials.tsx";
import { SetpointEntry } from "./SetpointEntry.tsx";

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

function SetpointPanel({ op }: { op: Operator }) {
  const [who, setWho] = useState<"manual" | "loop">("manual");
  const th = op.thermal;
  const target = op.thermalPlanStatus?.target_c ?? th?.target_c ?? null;
  const ceiling = op.thermalPlanStatus?.loop_ceiling_w ?? null;
  const gates = loopGates({
    runMode: th?.run_mode?.mode ?? "",
    controlRoi: th?.control_roi ?? null,
    tempStatus: th?.temp_status,
    replay: false,
    confidence: th?.shadow?.confidence ?? Number.NaN,
    liveWatchCount: (th?.watch ?? []).filter((w) => w.status === "ok").length,
    // ONLY the backend may say the interlock is armed; absent (older operator) = not armed.
    interlockArmed: th?.engage?.available === true,
    interlockReason: th?.engage?.reason ?? null,
  });
  const canEngage = engageAllowed(gates);
  async function engage() {
    try {
      const res = await api.engageLoop();
      if (!res.ok) op.flash(`Engage refused: ${await detail(res)}`, "warn");
      else op.flash("temperature loop engaged", "ok");
    } catch {
      op.flash("Engage failed: could not reach the operator");
    }
  }
  return (
    <section className="panel ck-sp" aria-label="Setpoint">
      <h2>
        <span>Setpoint</span>
        <span className="seg" role="tablist" aria-label="Who sets the power">
          <button className={`seg-btn ${who === "manual" ? "on" : ""}`} role="tab" aria-selected={who === "manual"} onClick={() => setWho("manual")}>
            Manual
          </button>
          <button className={`seg-btn ${who === "loop" ? "on" : ""}`} role="tab" aria-selected={who === "loop"} onClick={() => setWho("loop")}>
            Temp loop
          </button>
        </span>
      </h2>
      <div className="ck-spbody" hidden={who !== "manual"}>
        <label className="field-label" htmlFor="sp">Forward power setpoint (W)</label>
        <SetpointEntry
          controllable={op.controllable}
          setpointInput={op.setpointInput}
          setSetpointInput={op.setSetpointInput}
          setpointRef={op.setpointRef}
          applySetpoint={op.applySetpoint}
          nudgeSetpoint={op.nudgeSetpoint}
          onSetpointKey={op.onSetpointKey}
          ceilingW={op.limits?.max_forward_w ?? null}
        />
        <div className="ck-rfrow">
          <button className="btn danger" onClick={op.rfOn} disabled={!op.controllable || op.faulted}>RF ON</button>
          <button className="btn" onClick={op.rfOff} disabled={!op.connected}>RF OFF</button>
        </div>
      </div>
      <div className="ck-spbody" hidden={who !== "loop"}>
        <div className="ck-loopline">
          Hold at <b className="mono">{fin(target) ? `${target} °C` : "—"}</b> · ceiling{" "}
          <b className="mono">{fin(ceiling) ? `${ceiling} W` : "—"}</b>
        </div>
        <ul className="ck-gates" aria-label="Engage gates">
          {gates.map((g, i) => (
            <li key={i} title={g.text}>
              <span className={g.ok ? "ck-y" : "ck-n"} aria-label={g.ok ? "pass" : "fail"}>{g.ok ? "✓" : "✗"}</span>
              <span className="ck-gtext">{g.text}</span>
            </li>
          ))}
        </ul>
        <button className="btn accent" onClick={() => void engage()} disabled={!canEngage}>
          Engage temperature loop
        </button>
        <div className="ck-sub">Locked in this build: the loop's suggestion is shown and recorded, never applied.</div>
      </div>
    </section>
  );
}

function CapRow({ name, value, busy, op, bump }: {
  name: string;
  value: number | null | undefined;
  busy: boolean;
  op: Operator;
  bump: (d: number) => unknown;
}) {
  const off = !op.controllable || busy;
  return (
    <div className="ck-cap">
      <span className="ck-cap-lbl">{name}</span>
      <button className="btn" aria-label={`${name} down`} onClick={() => void bump(-1)} disabled={off}>−</button>
      <span className="ck-cap-v">{fin(value) ? value.toFixed(1) : "—"}<small>%</small></span>
      <button className="btn" aria-label={`${name} up`} onClick={() => void bump(1)} disabled={off}>+</button>
    </div>
  );
}

function MatchPanel({ op }: { op: Operator }) {
  const m = matchStatus(op.t);
  return (
    <section className="panel ck-match" aria-label="Match">
      <h2>
        <span>Match · manual</span>
        <span className={`ck-reflchip ck-${m.tone}`}>{m.chip}</span>
      </h2>
      <CapRow name="Tune" value={op.t?.tune_cap_percent} busy={op.capBusy === "tune"} op={op} bump={op.bumpTune} />
      <CapRow name="Load" value={op.t?.load_cap_percent} busy={op.capBusy === "load"} op={op} bump={op.bumpLoad} />
      <div className={`ck-matchline ck-${m.tone}`}>{m.text}</div>
    </section>
  );
}

export function CockpitStrip({ op }: { op: Operator }) {
  const rf = op.t?.rf_on;
  return (
    <div className="ck-strip">
      <section className="panel ck-meters" aria-label="Power meters">
        <h2>
          <span>Power</span>
          <span className={rf == null ? "ck-muted" : rf ? "ck-ok" : "ck-muted"}>{rf == null ? "RF —" : rf ? "RF ON" : "RF OFF"}</span>
        </h2>
        <PowerDials
          v={{
            requested: requestedW(op.ctrl),
            forward: op.t ? op.t.forward_w : null,
            load: op.t ? op.t.load_w : null,
            reverse: op.t ? op.t.reverse_w : null,
            powerCeil: op.powerCeil,
            fwdCaution: op.fwdCaution,
            fwdDanger: op.fwdDanger,
            maxRefl: op.maxRefl,
          }}
        />
        <DialNote powerCeil={op.powerCeil} fwdCaution={op.fwdCaution} fwdDanger={op.fwdDanger} maxRefl={op.maxRefl} />
      </section>
      <SetpointPanel op={op} />
      <MatchPanel op={op} />
    </div>
  );
}
