// Thermal column (spec §4): control-ROI picker, part temperature and rate, target and time to
// target, the shadow card with K, τ and confidence, and the temperature-status sentence. The ROI
// pick is an operator action through op.applyControlRoi; everything else is display.

import type { Operator } from "../../hooks/useOperator.ts";
import { f1 } from "../../lib/cockpit/format.ts";
import type { CockpitSample } from "../../lib/cockpit/history.ts";
import { partRate, tttText } from "../../lib/cockpit/live.ts";
import { confidenceSentence, shadowCard, type RunModeName } from "../../lib/cockpit/shadowText.ts";
import { tempStatusText } from "../../lib/thermalView.ts";

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

export function ThermalColumn({ op, buf }: { op: Operator; buf: CockpitSample[] }) {
  const th = op.thermal;
  const rois = th?.available_rois ?? [];
  const ctl = th?.control_roi ?? null;
  const mode = (th?.run_mode?.mode ?? "ladder") as RunModeName;
  const sh = th?.shadow;
  const target = op.thermalPlanStatus?.target_c ?? th?.target_c ?? Number.NaN;
  const rate = partRate(buf);
  const statusText = tempStatusText(th?.temp_status, ctl);
  const live = th?.temp_status === "ok";
  const card = sh ? shadowCard(mode, sh, op.t?.forward_w ?? Number.NaN, target) : null;
  const conf = sh && fin(sh.confidence) ? Math.round(sh.confidence * 100) : null;
  const options = ctl && !rois.includes(ctl) ? [ctl, ...rois] : rois;
  return (
    <section className="panel" aria-label="Thermal">
      <h2>
        <span>Thermal</span>
        <span className={`mono ${live ? "ck-ok" : "ck-warnc"}`}>{live ? "ok · live" : th?.temp_status ?? "unknown"}</span>
      </h2>
      <label className="ck-lbl" htmlFor="ck-ctl-roi">Control ROI (the part)</label>
      <div className="ck-roirow">
        <select
          id="ck-ctl-roi"
          className="ck-select"
          value={ctl ?? ""}
          disabled={!options.length}
          onChange={(e) => void op.applyControlRoi(e.target.value)}
        >
          {!ctl && <option value="">{options.length ? "— pick the part ROI —" : "no live FLIR ROIs"}</option>}
          {options.map((r) => (
            <option key={r} value={r}>{r === ctl && !rois.includes(r) ? `${r} (not in feed)` : r}</option>
          ))}
        </select>
        <span className="ck-sub">{rois.length} ROIs from the FLIR live feed</span>
      </div>
      <div className="ck-row2">
        <div className="ck-card">
          <div className="ck-lbl">Part</div>
          <div className="ck-big">{f1(th?.control_temp_c)}<small> °C</small></div>
          <div className="ck-sub ck-clamp2">{rate == null ? "rate: needs 30 s of readings" : `${rate >= 0 ? "+" : ""}${rate.toFixed(1)} °C/min`}</div>
        </div>
        <div className="ck-card">
          <div className="ck-lbl">Target</div>
          <div className="ck-big">{mode === "target" && fin(target) ? <>{target.toFixed(0)}<small> °C</small></> : "—"}</div>
          <div className="ck-sub ck-clamp2" title={tttText(mode, sh, target)}>{tttText(mode, sh, target)}</div>
        </div>
      </div>
      <div className="ck-card ck-shadowcard">
        {card ? (
          <>
            <div className="ck-lbl">{card.label}</div>
            <div className={`ck-big ${card.muted ? "ck-muted" : "ck-shadowc"}`}>{card.value}</div>
            <div className="ck-sub ck-line">{card.sub}</div>
          </>
        ) : (
          <div className="ck-sub">This operator does not report the shadow loop.</div>
        )}
        <dl className="ck-kv">
          <dt>Heating gain</dt><dd>{sh && sh.valid && fin(sh.k_c_per_w) ? `${sh.k_c_per_w.toFixed(2)} °C per W` : "—"}</dd>
          <dt>Time constant</dt><dd>{sh && sh.valid && fin(sh.tau_s) ? `${(sh.tau_s / 60).toFixed(1)} min` : "—"}</dd>
          <dt>Confidence</dt><dd>{conf == null ? "—" : `${conf} %`}</dd>
        </dl>
        <div className="ck-bar"><i style={{ width: `${conf ?? 0}%` }} /></div>
        <div className="ck-sub ck-conf">{sh ? confidenceSentence(sh) : ""}</div>
        <div className="ck-sub">
          Shadow loop: learns how <b>{ctl ?? "the control ROI"}</b> heats from your power changes. Recorded every
          sample; it never sends a command.
        </div>
      </div>
      <div className={`ck-status ${statusText ? "ck-warnc" : "ck-muted"}`}>{statusText ?? "Control temperature is live."}</div>
    </section>
  );
}
