import { useState } from "react";

import { api, detail } from "../lib/api.ts";

type Rec = Record<string, unknown>;

/** Loop geometry + limit editor. Partial POST; the server deep-merges and 422s bad values. */
export function SenseLoopSettings({ settings }: { settings: Rec | undefined }) {
  const geo = (settings?.geometry ?? {}) as Rec;
  const lim = (settings?.limits ?? {}) as Rec;
  const init = (v: unknown) => (v == null ? "" : String(v));
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const val = (k: string, cur: unknown) => f[k] ?? init(cur);
  const field = (k: string, label: string, cur: unknown, type = "number") => (
    <label className="ramp-field" style={{ flex: "0 0 110px" }} key={k}>
      <span>{label}</span>
      <input type={type} step="any" value={val(k, cur)} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  const save = async () => {
    const body: Rec = { geometry: {}, limits: {} };
    const g = body.geometry as Rec;
    const l = body.limits as Rec;
    const pick = (k: string, cur: unknown) => (f[k] !== undefined && f[k] !== init(cur) ? f[k] : undefined);
    const put = (t: Rec, k: string, cur: unknown) => {
      const v = pick(k, cur);
      if (v !== undefined) t[k] = v;
    };
    put(g, "turns", geo.turns);
    put(g, "cores_linked", geo.cores_linked);
    put(l, "probe_warn_v", lim.probe_warn_v);
    put(l, "probe_hard_v", lim.probe_hard_v);
    put(l, "flux_stop_mt", lim.flux_stop_mt);
    put(body, "probe_attn", settings?.probe_attn);
    put(body, "core_label", settings?.core_label);
    const r = await api.scopeSettings(body);
    if (r.ok) {
      setF({});
      setMsg("saved");
    } else {
      setMsg(await detail(r));
    }
  };
  return (
    <details>
      <summary>Loop geometry and limits</summary>
      <div className="ramp-actions">
        {field("turns", "Turns", geo.turns)}
        {field("cores_linked", "Cores linked", geo.cores_linked)}
        {field("probe_attn", "Probe ×", settings?.probe_attn)}
        {field("core_label", "Core label", settings?.core_label, "text")}
        {field("probe_warn_v", "Warn Vrms", lim.probe_warn_v)}
        {field("probe_hard_v", "Hard Vrms", lim.probe_hard_v)}
        {field("flux_stop_mt", "Flux stop mT", lim.flux_stop_mt)}
        <button className="btn" onClick={save}>Save</button>
      </div>
      {msg && <div className="hint">{msg}</div>}
    </details>
  );
}
