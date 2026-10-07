import { useEffect, useRef, useState } from "react";

import { api, detail } from "../lib/api.ts";
import { flagLabel, levelRows, scopeHeadline } from "../lib/scope.ts";
import type { ScopeReading, ScopeStatus } from "../lib/scope.ts";
import { SenseLoopSettings } from "./SenseLoopSettings.tsx";

export function SenseLoopPanel({ scope }: { scope: ScopeStatus | undefined }) {
  const h = scopeHeadline(scope);
  const [resource, setResource] = useState<string>(String(scope?.settings?.resource ?? ""));
  const [found, setFound] = useState<string[]>([]);
  const [msg, setMsg] = useState<string>("");
  const seen = useRef<ScopeReading[]>([]);
  const touched = useRef(false);
  const latest = scope?.latest;
  useEffect(() => {
    if (latest && seen.current.at(-1)?.host_timestamp_ns !== latest.host_timestamp_ns) {
      seen.current = [...seen.current.slice(-2000), latest];
    }
  }, [latest]);
  // Adopt the persisted resource once, unless the user already typed one.
  const persisted = String(scope?.settings?.resource ?? "");
  useEffect(() => {
    if (!touched.current && persisted) setResource(persisted);
  }, [persisted]);
  const flags = (latest?.flags ?? "").split(";").filter(Boolean).map(flagLabel);
  const run = async (p: Promise<Response>): Promise<boolean> => {
    const r = await p;
    setMsg(r.ok ? "" : await detail(r));
    return r.ok;
  };
  const find = async () => {
    try {
      const r = await api.scopeResources();
      if (!r.ok) return setMsg(await detail(r));
      setMsg("");
      setFound(((await r.json()) as { resources?: string[] }).resources ?? []);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const connect = async () => {
    if (await run(api.scopeSettings({ resource }))) await run(api.scopeConnect());
  };
  return (
    <section className="panel">
      <h2>Sense loop (scope)</h2>
      <div className="hint mono">{h.state}</div>
      <div className="ramp-actions">
        <label className="ramp-field" style={{ flex: "1 1 260px" }}>
          <span>VISA resource</span>
          <input
            list="scope-resources"
            value={resource}
            onChange={(e) => { touched.current = true; setResource(e.target.value); }}
            placeholder="TCPIP0::192.168.7.50::INSTR or USB0::…::INSTR"
          />
          <datalist id="scope-resources">{found.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        <button className="btn" onClick={find}>Find</button>
        {scope?.status.running ? (
          <button className="btn" onClick={() => run(api.scopeDisconnect())}>Disconnect</button>
        ) : (
          <button className="btn" onClick={connect}>Connect</button>
        )}
      </div>
      {msg && <div className="hint">{msg}</div>}
      <div className="mono">
        Vrms {h.vrms} · B {h.b} · f0 {h.f0} · pk-pk {h.pkpk} · H2 {h.h2} · level {h.level}
      </div>
      {flags.map((f) => (
        <div key={f.text} className={f.severity === "danger" ? "banner fault" : "banner warn"}>{f.text}</div>
      ))}
      <table className="mono">
        <thead><tr><th>Level</th><th>n</th><th>Vrms (median)</th><th>B (mT)</th></tr></thead>
        <tbody>
          {levelRows(seen.current).map((r) => (
            <tr key={r.level_w}>
              <td>{r.level_w} W</td><td>{r.n}</td><td>{r.vrms_median_v.toFixed(1)}</td>
              <td>{r.b_median_mt?.toFixed(2) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <SenseLoopSettings settings={scope?.settings} />
    </section>
  );
}
