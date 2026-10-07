import { useEffect, useRef, useState } from "react";

import { api, detail } from "../lib/api.ts";
import type { ScopeStatus } from "../lib/scope.ts";
import { SCOPE_MOCK as MOCK } from "../lib/scopeMockEnv.ts";
import {
  activeLevel, autoOpenSettings, configSummary, flagBanners, heroModel, levelCard,
  levelTable, scopePill, trendSeries,
} from "../lib/scopeView.ts";
import type { Meter, ScopeHistory } from "../lib/scopeView.ts";
import { ScopeTrend } from "./ScopeTrend.tsx";
import { SenseLoopSettings } from "./SenseLoopSettings.tsx";

const WINDOW_S = 300; // trend strip: last 5 minutes
const GAP_S = 3; // a longer gap between readings (stall / disconnect) breaks the trace

function MeterBar({ m }: { m: Meter }) {
  return (
    <>
      <div className="revmeter-track">
        {m.frac != null ? (
          <div className={`revmeter-fill ${m.zone === "live" ? "" : m.zone}`} style={{ width: `${m.frac * 100}%` }} />
        ) : null}
        {m.marks.map((k) => (
          <div key={k.cls} className={`revmeter-mark ${k.cls}`} style={{ left: `${k.frac * 100}%` }} />
        ))}
      </div>
      <div className="revmeter-legend">{m.legend}</div>
    </>
  );
}

/** `history` is owned by `useScopeHistory` at App level so it survives a tab switch (this panel unmounts). */
export function SenseLoopPanel({ scope: real, history }: { scope: ScopeStatus | undefined; history: ScopeHistory }) {
  const scope = MOCK?.scope ?? real;
  const latest = scope?.latest ?? null;

  const [nowNs, setNowNs] = useState(() => Date.now() * 1e6);
  useEffect(() => {
    const id = window.setInterval(() => setNowNs(Date.now() * 1e6), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Settings drawer: user toggle, else auto-open with no resource or on error.
  const auto = autoOpenSettings(scope);
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (auto) setOpen(null); // a new error / cleared resource re-opens it
  }, [auto]);
  const drawerOpen = open ?? auto;

  const persisted = String(scope?.settings?.resource ?? "");
  const [resource, setResource] = useState(persisted);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && persisted) setResource(persisted);
  }, [persisted]);
  const [found, setFound] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const run = async (p: Promise<Response>): Promise<boolean> => {
    try {
      const r = await p;
      setMsg(r.ok ? "" : await detail(r));
      return r.ok;
    } catch (e) {
      setMsg(String(e));
      return false;
    }
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
    if (!resource.trim()) {
      setOpen(true);
      setMsg("set a VISA resource first");
      return;
    }
    if (await run(api.scopeSettings({ resource }))) await run(api.scopeConnect());
  };

  const pill = scopePill(scope);
  const hero = heroModel(scope);
  const lvl = levelCard(scope);
  const banners = flagBanners(latest?.flags);
  const rows = levelTable(history.readings, activeLevel(scope));
  const points = trendSeries(history.samples, nowNs, WINDOW_S, GAP_S);
  const lim = (scope?.settings?.limits ?? {}) as Record<string, number>;
  const warnV = lim.probe_warn_v ?? 65;
  const hardV = lim.probe_hard_v ?? 70;
  const stopMt = lim.flux_stop_mt ?? 6;
  const tag = hero.blank ? <span className="sl-tag">{hero.blank}</span> : null;

  return (
    <section className="panel">
      <div className="sl-head">
        <div className="sl-head-left">
          <h2>Sense loop</h2>
          <span className={`pill static ${pill.cls}`} title={pill.detail ?? undefined}>
            <span className="dot" />
            {pill.text}
          </span>
          <span className="sl-config">{configSummary(scope?.settings)}</span>
        </div>
        <div className="sl-head-actions">
          {scope?.status.running ? (
            <button className="btn" onClick={() => run(api.scopeDisconnect())}>Disconnect</button>
          ) : (
            <button className="btn" onClick={connect}>Connect</button>
          )}
          <button
            className="btn icon"
            aria-pressed={drawerOpen}
            aria-label="Sense loop settings"
            title="Sense loop settings"
            onClick={() => setOpen(!drawerOpen)}
          >
            ⚙
          </button>
        </div>
      </div>
      {pill.kind === "error" ? <div className="sl-err" title={pill.detail ?? ""}>{pill.detail}</div> : null}
      {msg ? <div className="sl-err" title={msg}>{msg}</div> : null}

      {drawerOpen ? (
        <div className="sl-drawer">
          <div className="ramp-actions">
            <label className="ramp-field" style={{ flex: "1 1 260px" }}>
              <span>VISA resource</span>
              <input
                className="mono"
                list="scope-resources"
                value={resource}
                onChange={(e) => {
                  touched.current = true;
                  setResource(e.target.value);
                }}
                placeholder="TCPIP0::192.168.7.50::INSTR or USB0::…::INSTR"
              />
              <datalist id="scope-resources">
                {found.map((r) => <option key={r} value={r} />)}
              </datalist>
            </label>
            <button className="btn" onClick={find}>Find</button>
          </div>
          <SenseLoopSettings settings={scope?.settings} />
        </div>
      ) : null}

      {banners.length ? (
        <div className="sl-banners">
          {banners.map((f) => (
            <div key={f.text} className={f.severity === "danger" ? "banner fault" : "banner warn"}>{f.text}</div>
          ))}
        </div>
      ) : null}

      <div className="sl-cards">
        <div className={`readout ${hero.vrms.value ? `zone-${hero.vMeter.zone}` : ""}`}>
          <div className="sl-label-row"><span className="label">Loop Vrms</span>{tag}</div>
          {hero.vrms.value ? (
            <div className="value">{hero.vrms.value}<span className="unit">V</span></div>
          ) : hero.vrms.note ? (
            <div className="sl-note">{hero.vrms.note}</div>
          ) : (
            <div className="value">—</div>
          )}
          <MeterBar m={hero.vMeter} />
        </div>
        <div className={`readout ${hero.b.value && hero.b.value !== "—" ? `zone-${hero.bMeter.zone}` : ""}`}>
          <div className="sl-label-row"><span className="label">Core flux B<sub>pk</sub></span>{tag}</div>
          {hero.b.value && hero.b.value !== "—" ? (
            <div className="value">{hero.b.value}<span className="unit">mT</span></div>
          ) : (
            <div className="value">—</div>
          )}
          <MeterBar m={hero.bMeter} />
        </div>
        <div className="readout">
          <div className="label">Level</div>
          <div className={lvl.assigned || lvl.big === "—" ? "value" : "value muted"}>{lvl.big}</div>
          {lvl.sub ? <div className="sl-sub">{lvl.sub}</div> : null}
          {lvl.vps ? <div className="sl-sub"><strong>{lvl.vps}</strong></div> : null}
        </div>
      </div>

      <div className="sl-secondary">
        <span><span className="k">f0</span>{hero.f0 === "—" ? "—" : `${hero.f0} MHz`}</span>
        <span><span className="k">pk-pk</span>{hero.pkpk}</span>
        <span><span className="k">H2</span>{hero.h2}</span>
        <span><span className="k">H3</span>{hero.h3}</span>
        <span><span className="k">fit resid</span>{hero.resid}</span>
        {tag}
      </div>

      <ScopeTrend
        points={points}
        windowS={WINDOW_S}
        vCeil={hardV * 1.1}
        bCeil={stopMt * 1.33}
        probeWarnV={warnV}
        fluxStopMt={stopMt}
      />
      <div className="plot-legend">
        <span><span className="swatch fwd" />Vrms (0–{Math.round(hardV * 1.1)} V)</span>
        <span><span className="swatch refl" />B<sub>pk</sub> (0–{(stopMt * 1.33).toFixed(1)} mT)</span>
        <span><span className="swatch ref-probe" />probe warn {warnV} V</span>
        <span><span className="swatch ref-flux" />flux stop {stopMt.toFixed(1)} mT</span>
      </div>

      {rows.length ? (
        <table className="sl-table">
          <thead>
            <tr><th>Level</th><th>N</th><th>Vrms</th><th>V/√W</th><th>B mT</th><th>H2 %</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.active ? "active" : undefined}>
                <td><span className="marker">{r.active ? "▸" : ""}</span>{r.level}</td>
                <td>{r.n}</td><td>{r.vrms}</td><td>{r.vps}</td><td>{r.b}</td><td>{r.h2}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="sl-table-empty">no assigned power levels yet this session</div>
      )}
    </section>
  );
}
