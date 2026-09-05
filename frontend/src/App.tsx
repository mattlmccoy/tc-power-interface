import { useEffect, useRef, useState } from "react";

import { TimePlot } from "./components/TimePlot.tsx";
import { api, detail, operatorBase, setOperatorBase, SITE_MODE } from "./lib/api.ts";
import type { FlirLink } from "./lib/api.ts";
import {
  flirStatusLabel,
  fmtPct,
  fmtTemp,
  fmtWatts,
  reflectedZone,
  statusFlagNames,
} from "./lib/format.ts";
import { wsUrl } from "./lib/operator.ts";
import { TraceBuffer } from "./lib/telemetry.ts";
import type { Point, Status } from "./lib/telemetry.ts";

const FLIR_POLL_MS = 3000;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [setpointInput, setSetpointInput] = useState("100");
  const [tune, setTune] = useState(50);
  const [load, setLoad] = useState(50);
  const [manual, setManual] = useState(false);
  const [runName, setRunName] = useState("");
  const [plot, setPlot] = useState<{ fwd: Point[]; refl: Point[] }>({ fwd: [], refl: [] });
  const [base, setBase] = useState(operatorBase());
  const [baseInput, setBaseInput] = useState(operatorBase());
  const [flirUrlInput, setFlirUrlInput] = useState("");
  const [flirEnabled, setFlirEnabled] = useState(false);
  const [flirLast, setFlirLast] = useState<FlirLink["last_result"] | null>(null);

  const fwdBuf = useRef(new TraceBuffer(150));
  const reflBuf = useRef(new TraceBuffer(150));

  const applyBase = () => {
    setOperatorBase(baseInput);
    setBase(operatorBase());
    setBaseInput(operatorBase());
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(wsUrl(base, "/ws/telemetry"));
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        const s = JSON.parse(ev.data) as Status;
        setStatus(s);
        const t = s.controller.telemetry;
        if (t) {
          const ts = t.host_timestamp_ns / 1e9;
          fwdBuf.current.push(ts, t.forward_w);
          reflBuf.current.push(ts, t.reflected_fraction * 100);
          setPlot({ fwd: fwdBuf.current.toArray(), refl: reflBuf.current.toArray() });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const link = await api.flirLink();
        if (cancelled) return;
        setFlirUrlInput(link.url);
        setFlirEnabled(link.enabled);
        setFlirLast(link.last_result);
      } catch {
        /* operator unreachable — status line stays at its last known value */
      }
    };
    load();
    const poll = setInterval(async () => {
      try {
        const link = await api.flirLink();
        if (!cancelled) setFlirLast(link.last_result);
      } catch {
        /* transient poll failure — keep showing the last known result */
      }
    }, FLIR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [base]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const ctrl = status?.controller;
  const t = ctrl?.telemetry ?? null;
  const limits = ctrl?.limits;
  const device = status?.device;
  const recording = status?.recording;
  const state = ctrl?.state ?? "disconnected";
  const pillState = !connected ? "disconnected" : state === "fault" ? "fault" : "connected";
  const faulted = state === "fault";
  const warn = limits?.reflected_fraction_warn ?? 0.02;
  const trip = limits?.reflected_fraction_trip ?? 0.1;
  const zone = t ? reflectedZone(t.reflected_fraction, warn, trip) : "ok";
  const powerCeil = device?.power_limit_w ?? 600;
  const reflectCeil = Math.max(trip * 100 * 1.5, 5);

  async function rfOn() {
    if (!window.confirm("Enable RF output now? The generator will begin delivering power.")) return;
    const res = await api.rfEnable();
    if (!res.ok) flash("RF enable refused: " + (await detail(res)));
  }
  async function rfOff() {
    await api.rfDisable();
  }
  async function applySetpoint() {
    const watts = Number(setpointInput);
    if (Number.isNaN(watts)) return flash("setpoint must be a number");
    const res = await api.setSetpoint(watts);
    if (res.ok) {
      const j = await res.json();
      flash(`setpoint applied: ${j.applied_w} W${j.applied_w !== watts ? " (clamped)" : ""}`);
    } else {
      flash(await detail(res));
    }
  }
  async function toggleManual(on: boolean) {
    setManual(on);
    await api.manual(on);
  }
  async function sendTune(v: number) {
    setTune(v);
    await api.tune(v);
  }
  async function sendLoad(v: number) {
    setLoad(v);
    await api.load(v);
  }
  async function applyFlirLink(url: string, enabled: boolean) {
    try {
      const res = await api.setFlirLink(url.trim(), enabled);
      if (res.ok) {
        const link = (await res.json()) as FlirLink;
        setFlirUrlInput(link.url);
        setFlirEnabled(link.enabled);
        setFlirLast(link.last_result);
      } else {
        flash("FLIR link update failed: " + (await detail(res)));
      }
    } catch {
      flash("FLIR link update failed: could not reach operator");
    }
  }
  function applyFlirUrl() {
    applyFlirLink(flirUrlInput, flirEnabled);
  }
  function toggleFlirEnabled(on: boolean) {
    setFlirEnabled(on);
    applyFlirLink(flirUrlInput, on);
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          T<span className="amp">&amp;</span>C Power Interface
        </span>
        <span className="device">
          {device?.id ? `${device.id} · ${device.serial ?? ""}` : "no device"}
          {device?.frequency_hz ? ` · ${(device.frequency_hz / 1e6).toFixed(2)} MHz` : ""}
        </span>
        <span className="spacer" />
        {SITE_MODE ? (
          <label className="op-field" title="Local operator (tcp-serve) this UI connects to">
            operator
            <input
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              onBlur={applyBase}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyBase();
              }}
              placeholder="http://localhost:8000"
            />
          </label>
        ) : null}
        <span className={`pill ${pillState}`}>
          <span className="dot" />
          {pillState}
        </span>
      </header>

      {faulted ? (
        <div className="banner fault">
          <strong>FAULT — RF disabled.</strong> {ctrl?.fault_reasons.join("; ")}
        </div>
      ) : ctrl && ctrl.warnings.length > 0 ? (
        <div className="banner warn">
          <strong>WARNING.</strong> {ctrl.warnings.join("; ")}
        </div>
      ) : null}

      <div className="main">
        <div className="col">
          <section className="panel">
            <h2>Telemetry</h2>
            <div className="cards">
              <div className="readout">
                <div className="label">Forward power</div>
                <div className={`value ${t?.rf_on ? "rf-on" : ""}`}>
                  {t ? fmtWatts(t.forward_w) : "—"}
                </div>
              </div>
              <div className={`readout zone-${zone}`}>
                <div className="label">Reflected</div>
                <div className="value">{t ? fmtPct(t.reflected_fraction) : "—"}</div>
              </div>
              <div className="readout">
                <div className="label">Load power</div>
                <div className="value">{t ? fmtWatts(t.load_w) : "—"}</div>
              </div>
              <div className="readout">
                <div className="label">Heat-sink temp</div>
                <div className="value">{t ? fmtTemp(t.temperature_c) : "—"}</div>
              </div>
            </div>
            <div className="hint mono">
              RF {t?.rf_on ? "ON" : "off"} · mode {t?.operation_mode ?? "—"} · tuner{" "}
              {t?.tuner ?? "—"}
              {t && statusFlagNames(t.status).length > 0
                ? ` · ${statusFlagNames(t.status).join(", ")}`
                : ""}
            </div>
          </section>

          <section className="panel">
            <h2>Reflected power</h2>
            <div className="gauge">
              <div
                className={`fill ${zone}`}
                style={{ width: `${Math.min(100, ((t?.reflected_fraction ?? 0) / reflectCeil) * 100 * 100)}%` }}
              />
            </div>
            <div className="gauge-legend">
              <span>0%</span>
              <span>
                warn {fmtPct(warn)} · trip {fmtPct(trip)}
              </span>
              <span>{fmtPct(reflectCeil / 100)}</span>
            </div>
          </section>

          <section className="panel">
            <h2>History</h2>
            <TimePlot
              forward={plot.fwd}
              reflectedPct={plot.refl}
              powerCeil={powerCeil}
              reflectCeil={reflectCeil}
            />
            <div className="plot-legend">
              <span>
                <span className="swatch fwd" />
                forward power (0–{powerCeil} W)
              </span>
              <span>
                <span className="swatch refl" />
                reflected (0–{fmtPct(reflectCeil / 100)})
              </span>
            </div>
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <h2>Power setpoint</h2>
            <label className="field-label" htmlFor="sp">
              Forward power (W)
            </label>
            <div className="row">
              <input
                id="sp"
                type="number"
                min={0}
                value={setpointInput}
                onChange={(e) => setSetpointInput(e.target.value)}
              />
              <button className="btn accent" onClick={applySetpoint} disabled={!connected}>
                Apply
              </button>
            </div>
            <div className="hint">
              Policy ceiling {limits?.max_setpoint_w ?? "—"} W (values above are clamped).
            </div>
          </section>

          <section className="panel">
            <h2>RF output</h2>
            <div className="row">
              <button className="btn danger full" onClick={rfOn} disabled={!connected || faulted}>
                RF ON
              </button>
              <button className="btn full" onClick={rfOff} disabled={!connected}>
                RF OFF
              </button>
            </div>
            <div className="hint">
              {faulted
                ? "RF-enable is blocked while faulted (protection latched)."
                : "RF-enable prompts for confirmation. Protection commands RF off on any trip."}
            </div>
          </section>

          <section className="panel">
            <h2>Matching network</h2>
            <label className="toggle">
              <input
                type="checkbox"
                checked={manual}
                onChange={(e) => toggleManual(e.target.checked)}
                disabled={!connected}
              />
              Manual tune mode
            </label>
            <div style={{ marginTop: "12px" }}>
              <label className="field-label">Tune {tune}%</label>
              <input
                type="range"
                min={0}
                max={100}
                value={tune}
                disabled={!manual}
                onChange={(e) => sendTune(Number(e.target.value))}
              />
              <label className="field-label">Load {load}%</label>
              <input
                type="range"
                min={0}
                max={100}
                value={load}
                disabled={!manual}
                onChange={(e) => sendLoad(Number(e.target.value))}
              />
            </div>
            <div className="hint">Capacities are writable only in manual mode.</div>
          </section>

          <section className="panel">
            <h2>Recording</h2>
            {recording?.active ? (
              <>
                <button className="btn rec full" onClick={() => api.stopRecording()}>
                  ■ Stop recording
                </button>
                <div className="hint mono">recording → {recording.run}</div>
              </>
            ) : (
              <>
                <input
                  className="mono"
                  style={{
                    width: "100%",
                    background: "var(--bg-deep)",
                    border: "1px solid var(--line-control)",
                    borderRadius: "var(--radius)",
                    padding: "8px 10px",
                    marginBottom: "8px",
                  }}
                  placeholder="run name"
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                />
                <button
                  className="btn full"
                  disabled={!connected}
                  onClick={() => api.startRecording(runName.trim() || "run", "")}
                >
                  ● Start recording
                </button>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Instruments</h2>
            <label className="field-label" htmlFor="flir-url">
              FLIR link URL
            </label>
            <input
              id="flir-url"
              className="mono"
              style={{
                width: "100%",
                background: "var(--bg-deep)",
                border: "1px solid var(--line-control)",
                borderRadius: "var(--radius)",
                padding: "8px 10px",
                marginBottom: "8px",
              }}
              placeholder="http://localhost:8000"
              value={flirUrlInput}
              onChange={(e) => setFlirUrlInput(e.target.value)}
              onBlur={applyFlirUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFlirUrl();
              }}
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={flirEnabled}
                onChange={(e) => toggleFlirEnabled(e.target.checked)}
              />
              Enable FLIR link
            </label>
            <div className="hint mono">{flirStatusLabel(flirLast)}</div>
            <div className="hint">
              RF on/off starts + annotates a FLIR recording (FLIR owns stop-vs-keep).
            </div>
          </section>
        </div>
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
