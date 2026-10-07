// Run mode (spec §4, D4): the mode chips and the per-mode panel. Run mode is bookkeeping only; it
// never sets power. The one power action here, "Next step", is an operator click through
// op.nudgeSetpoint, the same path as the setpoint −/+ buttons.

import { useEffect, useState } from "react";

import type { Operator } from "../../hooks/useOperator.ts";
import { api, detail } from "../../lib/api.ts";
import { f1, mmss } from "../../lib/cockpit/format.ts";
import { ladderStep, nextPlateau, parseLadder } from "../../lib/cockpit/ladder.ts";
import { ladderBase } from "../../lib/cockpit/power.ts";
import { requestedW } from "../../lib/power.ts";
import type { RunModeName } from "../../lib/cockpit/shadowText.ts";
import type { RunMode } from "../../lib/telemetry.ts";

const MODE_LABEL: Record<RunModeName, string> = { ladder: "Power ladder", fixed: "Fixed power", target: "To temperature" };
const MODE_SHORT: Record<RunModeName, string> = { ladder: "ladder", fixed: "fixed", target: "to temperature" };

async function saveRunMode(op: Operator, m: RunMode) {
  try {
    const res = await api.setRunMode(m);
    if (!res.ok) op.flash(`run mode: ${await detail(res)}`);
  } catch {
    op.flash("run mode: could not reach the operator");
  }
}

/** The mode chips for the page header. Angle schedule is shown, disabled (turntable not built). */
export function ModeChips({ op }: { op: Operator }) {
  const rm = op.thermal?.run_mode;
  return (
    <div className="ck-chips" role="tablist" aria-label="Run mode">
      {(Object.keys(MODE_LABEL) as RunModeName[]).map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={rm?.mode === m}
          className={`ck-chip ${rm?.mode === m ? "on" : ""}`}
          disabled={!rm}
          onClick={() => rm && rm.mode !== m && void saveRunMode(op, { ...rm, mode: m })}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
      <button className="ck-chip" role="tab" aria-disabled="true" disabled title="Angle schedule: turntable not built">
        Angle schedule
      </button>
    </div>
  );
}

function LadderPanel({ op, rm }: { op: Operator; rm: RunMode }) {
  const saved = rm.ladder_w.join(" ");
  const [text, setText] = useState(saved);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setText(saved); }, [saved, dirty]);
  const parsed = parseLadder(text);
  // The step is read from the commanded setpoint (forward lags a ramp and wobbles), else forward.
  const { index, next } = ladderStep(rm.ladder_w, ladderBase(requestedW(op.ctrl), op.t?.forward_w ?? Number.NaN));
  const sh = op.thermal?.shadow;
  const plat = next != null && sh ? nextPlateau(sh, next) : null;
  const save = () => { setDirty(false); void saveRunMode(op, { ...rm, ladder_w: parsed.steps }); };
  return (
    <>
      <label className="ck-lbl" htmlFor="ck-ladder">Steps (W)</label>
      <div className="ck-inline">
        <input
          id="ck-ladder"
          className="ck-text"
          value={text}
          placeholder="e.g. 10 20 30 40"
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button className="btn" onClick={save} disabled={!dirty}>Save</button>
      </div>
      <div className="ck-sub ck-oneline ck-warnc" title={parsed.rejected.join(", ")}>
        {parsed.rejected.length ? `ignored: ${parsed.rejected.join(", ")}` : ""}
      </div>
      <dl className="ck-kv">
        <dt>Steps</dt>
        <dd>
          {rm.ladder_w.length
            ? rm.ladder_w.map((w, k) => (
                <span key={w} className={index != null && k === index - 1 ? "ck-cur" : ""}>{k ? " · " : ""}{w}</span>
              ))
            : "none set"}
          {rm.ladder_w.length ? " W" : ""}
        </dd>
        <dt>Step</dt><dd>{index == null ? "—" : `${index} of ${rm.ladder_w.length}`}</dd>
        <dt>Next step</dt><dd>{next == null ? "—" : `${next} W → levels off ≈ ${plat == null ? "—" : `${f1(plat)} °C`}`}</dd>
      </dl>
      <div className="ck-actions">
        <button
          className="btn accent"
          disabled={!op.controllable || next == null}
          // nudgeSetpoint(d) sends setpointRef + d (clamped), so d = N − setpointRef sends exactly N.
          // A commanded/forward base would send setpointRef + N − base: wrong whenever they differ.
          onClick={() => next != null && op.nudgeSetpoint(next - op.setpointRef.current)}
        >
          {/* The generator takes whole watts and the nudge rounds (stepSetpoint): label = what is sent. */}
          {next != null ? `Next step → ${Math.round(next)} W` : rm.ladder_w.length ? "Ladder done" : "Set steps first"}
        </button>
      </div>
      <div className="ck-sub">You click to advance; nothing steps on its own.</div>
    </>
  );
}

function FixedPanel({ op, rm }: { op: Operator; rm: RunMode }) {
  const [w, setW] = useState(String(rm.fixed_w));
  useEffect(() => setW(String(rm.fixed_w)), [rm.fixed_w]);
  const tm = op.timer;
  return (
    <>
      <div className="ck-inline">
        <label className="ck-lbl" htmlFor="ck-fixed-w">Hold (W)</label>
        <input id="ck-fixed-w" className="ck-num" type="number" min={0} value={w} onChange={(e) => setW(e.target.value)} />
        <button
          className="btn"
          disabled={String(rm.fixed_w) === w || w.trim() === "" || !Number.isFinite(Number(w))}
          onClick={() => void saveRunMode(op, { ...rm, fixed_w: Number(w), fixed_min: Number(op.timerMin) || rm.fixed_min })}
        >
          Save
        </button>
      </div>
      <dl className="ck-kv">
        <dt>Forward now</dt><dd>{op.t ? `${f1(op.t.forward_w)} W` : "—"}</dd>
        <dt>Timer</dt>
        <dd>{tm ? (tm.running ? `${mmss(tm.remaining_s)} left of ${mmss(tm.minutes * 60)}` : tm.done ? "done: RF switched off" : "not running") : "—"}</dd>
      </dl>
      <div className="ck-inline">
        <label className="ck-lbl" htmlFor="ck-timer">Auto-off (min)</label>
        <input id="ck-timer" className="ck-num" type="number" min={0} value={op.timerMin} onChange={(e) => op.setTimerMin(e.target.value)} />
        <button className="btn" onClick={() => void op.startTimer()} disabled={!op.controllable || !!tm?.running}>Start</button>
        <button className="btn" onClick={() => void op.stopTimer()} disabled={!tm?.running}>Stop</button>
      </div>
      <div className="ck-sub">Uses the existing auto-shutoff timer (RF off when it ends). Power is yours to set.</div>
    </>
  );
}

function TargetPanel({ op }: { op: Operator }) {
  const f = op.thermalForm;
  const field = (key: "target_c" | "soak_s" | "loop_ceiling_w", label: string) => (
    <div className="ck-inline">
      <label className="ck-lbl" htmlFor={`ck-${key}`}>{label}</label>
      <input
        id={`ck-${key}`}
        className="ck-num"
        type="number"
        value={f[key]}
        onChange={(e) => op.setThermalForm({ ...f, [key]: e.target.value })}
      />
    </div>
  );
  return (
    <>
      {field("target_c", "Target (°C)")}
      {field("soak_s", "Soak (s)")}
      {field("loop_ceiling_w", "Power ceiling (W)")}
      <div className="ck-actions">
        <button className="btn" onClick={() => void op.saveThermalPlan()}>Save plan</button>
      </div>
      <div className="ck-sub">The shadow loop's suggestion is shown and recorded, never applied.</div>
    </>
  );
}

export function RunModeColumn({ op }: { op: Operator }) {
  const rm = op.thermal?.run_mode;
  return (
    <section className="panel" aria-label="Run mode">
      <h2>
        <span>Run mode</span>
        <span className="mono">{rm ? MODE_SHORT[rm.mode] ?? rm.mode : "—"}</span>
      </h2>
      <div className="ck-modebody">
        {!rm ? (
          <div className="ck-sub">This operator does not report a run mode.</div>
        ) : rm.mode === "ladder" ? (
          <LadderPanel op={op} rm={rm} />
        ) : rm.mode === "fixed" ? (
          <FixedPanel op={op} rm={rm} />
        ) : (
          <TargetPanel op={op} />
        )}
      </div>
    </section>
  );
}
