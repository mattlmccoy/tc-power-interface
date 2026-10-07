import { useState } from "react";
import { useCockpitThresholds } from "../hooks/useCockpitThresholds.ts";
import { COCKPIT_BOUNDS, saveCockpitThresholds, settingsStorage } from "../lib/settings_store.ts";

/** Watched-core warning thresholds for the Closed-loop cockpit. Per browser; display + warn only. */
export function CockpitWarnPanel() {
  const cur = useCockpitThresholds();
  const [temp, setTemp] = useState(String(cur.tempC));
  const [rate, setRate] = useState(String(cur.ratePerMin));
  const [msg, setMsg] = useState("");
  const [lo, hi] = COCKPIT_BOUNDS.tempC;
  const [rlo, rhi] = COCKPIT_BOUNDS.ratePerMin;
  const t = Number(temp);
  const r = Number(rate);
  const valid = temp.trim() !== "" && rate.trim() !== "" && Number.isFinite(t) && Number.isFinite(r);
  function save() {
    if (!valid) { setMsg("Enter a number in both fields."); return; }
    const c = { tempC: Math.min(hi, Math.max(lo, t)), ratePerMin: Math.min(rhi, Math.max(rlo, r)) };
    if (!saveCockpitThresholds(settingsStorage(), c)) {
      setMsg("Not saved: browser storage unavailable. The cockpit keeps its current thresholds.");
      return;
    }
    setTemp(String(c.tempC));
    setRate(String(c.ratePerMin));
    setMsg(`Saved: warn ≥ ${c.tempC} °C or ≥ ${c.ratePerMin} °C/min.`);
  }
  return (
    <section className="panel" aria-label="Cockpit core warnings">
      <h2>Cockpit — core warnings</h2>
      <div className="hint">
        When a watched core ROI reaches either value, the Closed-loop page marks it as a warning
        (display only, nothing is switched off).{" "}
        {cur.provisional ? "Currently the provisional defaults — set them from run data." : "Set from your saved values."}{" "}
        Stored in this browser.
      </div>
      <label className="field-label">Core temperature (°C) ({lo}–{hi})</label>
      <input type="number" value={temp} onChange={(e) => { setTemp(e.target.value); setMsg(""); }} />
      <label className="field-label" style={{ marginTop: "10px" }}>Core rise rate (°C/min) ({rlo}–{rhi})</label>
      <input type="number" value={rate} onChange={(e) => { setRate(e.target.value); setMsg(""); }} />
      <button className="btn accent full" style={{ marginTop: "12px" }} onClick={save}>
        Save core warnings
      </button>
      {msg ? <div className="hint" role="status">{msg}</div> : null}
    </section>
  );
}
