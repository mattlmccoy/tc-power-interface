// Run clock in the top bar (design docs/superpowers/specs/2026-11-18-run-clock-design.md): a chip
// that counts down RF-on time against the target typed in from the sims, a pop-up to set / extend /
// cancel it, and a fixed time's-up pop-up. A REMINDER only: nothing here touches RF.

import { useState } from "react";

import { api, detail } from "../lib/api.ts";
import { chipView, fmtClock, overBanner, parseClockEntry, type RunClockBlock } from "../lib/runClock.ts";

interface Props {
  rc: RunClockBlock | undefined;
  flash: (msg: string, tone?: "ok" | "err" | "warn") => void;
  muted: boolean;
  setMuted: (on: boolean) => void;
  unlock: () => void;
}

async function send(call: Promise<Response>, flash: Props["flash"], what: string): Promise<boolean> {
  try {
    const res = await call;
    if (!res.ok) {
      flash(`run clock ${what}: ${await detail(res)}`);
      return false;
    }
    return true;
  } catch {
    flash(`run clock ${what}: could not reach the operator`);
    return false;
  }
}

export function RunClockChip({ rc, flash, muted, setMuted, unlock }: Props) {
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState("");
  const [sec, setSec] = useState("");
  const v = chipView(rc);
  const isSet = rc?.set === true;

  const openPop = () => {
    if (!open && rc?.target_s != null) {
      setMin(String(Math.floor(rc.target_s / 60)));
      setSec(String(Math.round(rc.target_s % 60)).padStart(2, "0"));
    }
    setOpen((o) => !o);
  };
  const entry = parseClockEntry(min, sec);
  const apply = async () => {
    if (entry === null) return;
    unlock(); // this click is the gesture that lets the chimes play
    if (await send(api.runClockSet(entry), flash, "set")) setOpen(false);
  };

  return (
    <span className="runclock-wrap">
      <button
        className={`runclock runclock-${v.level}`}
        onClick={openPop}
        title="Run clock: counts RF-on time against the target from the sims. A reminder only; it never turns RF on or off. Click to set, add time, or cancel."
      >
        <span className="runclock-icon" aria-hidden="true">{v.level === "paused" ? "⏸" : "⏱"}</span>
        <span className="runclock-main">{v.main}</span>
        <span className="runclock-sub">{v.sub}</span>
        <span className="runclock-bar" aria-hidden="true"><i style={{ width: `${v.pct}%` }} /></span>
      </button>
      {open ? (
        <div className="runclock-pop" role="dialog" aria-label="Run clock">
          <div className="connect-head">
            <strong>Run clock</strong>
            <button className="pop-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="runclock-help">RF-on time this run needs (from the sims). Counts only while RF is on; chimes at 2 min and 30 s left and when time is up. Never turns RF on or off.</div>
          <div className="runclock-entry">
            <input aria-label="minutes" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void apply()} placeholder="12" />
            <span>:</span>
            <input aria-label="seconds" inputMode="numeric" value={sec} onChange={(e) => setSec(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void apply()} placeholder="00" />
            <span className="runclock-unit">min : sec</span>
          </div>
          <div className="runclock-actions">
            <button className="btn accent" disabled={entry === null} onClick={() => void apply()}>
              {isSet ? "Restart" : "Set"}{entry !== null ? ` ${fmtClock(entry)}` : ""}
            </button>
            <button className="btn" disabled={!isSet} onClick={() => void send(api.runClockAdd(60), flash, "+1 min")}>+1 min</button>
            <button className="btn" disabled={!isSet} onClick={() => void send(api.runClockCancel(), flash, "cancel").then((ok) => ok && setOpen(false))}>Cancel clock</button>
          </div>
          {isSet && rc?.on_s != null ? (
            <div className="runclock-help mono">RF-on so far {fmtClock(rc.on_s)} of {fmtClock(rc.target_s ?? 0)}{rc.counting ? "" : " · paused, RF off"}</div>
          ) : null}
          <label className="runclock-mute">
            <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} /> Mute run-clock chimes (this browser)
          </label>
        </div>
      ) : null}
    </span>
  );
}

/** The fixed time's-up pop-up: position fixed so it never moves the page (HARD UI rule). */
export function TimeUpPopup({ rc, flash }: { rc: RunClockBlock | undefined; flash: Props["flash"] }) {
  const text = overBanner(rc);
  if (!text) return null;
  return (
    <div className="timeup-pop" role="alert">
      <span>⏱ {text}</span>
      <button className="btn" onClick={() => void send(api.runClockDismiss(), flash, "dismiss")}>Dismiss</button>
    </div>
  );
}
