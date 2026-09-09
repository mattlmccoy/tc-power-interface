import type { Dispatch, SetStateAction } from "react";
import type { DeviceInfo } from "../lib/telemetry.ts";
import { SITE_MODE, type Health, type SerialPort } from "../lib/api.ts";
import { UI_API_VERSION, UI_VERSION } from "../lib/operator.ts";

interface ConnectBarProps {
  pillState: string;
  showConnect: boolean;
  setShowConnect: Dispatch<SetStateAction<boolean>>;
  ports: SerialPort[] | null;
  connectBusy: string | null;
  connectErr: string | null;
  connected: boolean;
  device: DeviceInfo | undefined;
  reachable: boolean;
  health: Health | null;
  baseInput: string;
  setBaseInput: (v: string) => void;
  applyBase: () => void;
  scanPorts: () => void;
  connectPort: (p: string) => void;
  disconnectDevice: () => void;
  setPorts: (p: null) => void;
  setConnectErr: (e: null) => void;
  vnaConnect: () => void;
  vnaConnected: boolean;
  vnaEnd: () => void;
}

export function ConnectBar(props: ConnectBarProps) {
  const {
    pillState, showConnect, setShowConnect, ports, connectBusy, connectErr, connected, device,
    reachable, health, baseInput, setBaseInput, applyBase, scanPorts, connectPort, disconnectDevice,
    setPorts, setConnectErr, vnaConnect, vnaConnected, vnaEnd,
  } = props;
  const isVna = (p: SerialPort) => /nanovna/i.test(p.description) || /0483:5740/i.test(p.hwid);
  return (
        <div className="connect-wrap">
          <button
            className={`pill ${pillState}`}
            onClick={() => {
              setShowConnect((v) => !v);
              if (ports === null) void scanPorts();
            }}
            title="Connect a generator / set the operator address"
          >
            <span className="dot" />
            {pillState}
            <span className="pill-caret">▾</span>
          </button>
          {showConnect ? (
            <div className="connect-pop">
              <div className="connect-head">
                <strong>Connection</strong>
                <button className="pop-close" onClick={() => setShowConnect(false)}>
                  ✕
                </button>
              </div>

              {SITE_MODE ? (
                <div className="connect-sec">
                  <label className="field-label">Operator address</label>
                  <div className="connect-row">
                    <input
                      value={baseInput}
                      onChange={(e) => setBaseInput(e.target.value)}
                      placeholder="http://localhost:8010"
                      spellCheck={false}
                    />
                    <button
                      className="btn"
                      onClick={() => {
                        applyBase();
                        setPorts(null);
                        setConnectErr(null);
                      }}
                    >
                      Apply
                    </button>
                  </div>
                  <div className="hint help-text">
                    The local operator that serves your generator. Default{" "}
                    <code>http://localhost:8010</code>.
                  </div>
                </div>
              ) : null}

              <div className="connect-sec">
                <div className="connect-row connect-row-head">
                  <label className="field-label">Generator</label>
                  <button className="btn" onClick={scanPorts} disabled={connectBusy === "scanning"}>
                    {connectBusy === "scanning" ? "Scanning…" : "Scan"}
                  </button>
                </div>

                {connected ? (
                  <div className="connect-current">
                    <span>Connected{device?.id ? ` — ${device.id}` : ""}</span>
                    <button className="btn danger" onClick={disconnectDevice} disabled={connectBusy === "disconnect"}>
                      {connectBusy === "disconnect" ? "…" : "Disconnect"}
                    </button>
                  </div>
                ) : ports === null ? (
                  <div className="hint">Scan to find the generator's serial port.</div>
                ) : ports.filter((p) => !isVna(p)).length === 0 ? (
                  <div className="errbox">
                    No generator serial port found. Plug in the generator's USB-serial cable and Scan again.
                  </div>
                ) : (
                  <ul className="port-list">
                    {ports.filter((p) => !isVna(p)).map((p) => (
                      <li key={p.device}>
                        <div className="port-info">
                          <div className="port-name">{p.description || p.device}</div>
                          <code>{p.device}</code>
                        </div>
                        <button
                          className="btn accent"
                          onClick={() => connectPort(p.device)}
                          disabled={connectBusy !== null}
                        >
                          {connectBusy === p.device ? "Connecting…" : "Connect"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {connectErr ? <div className="errbox">{connectErr}</div> : null}
                <div className="hint help-text">Drives the AIT caps. Connecting is read-only — RF stays off.</div>
              </div>

              <div className="connect-sec">
                <label className="field-label">NanoVNA (VNA tune)</label>
                {vnaConnected ? (
                  <div className="connect-current">
                    <span>Connected — VNA mode</span>
                    <button className="btn danger" onClick={() => { setShowConnect(false); vnaEnd(); }}>End</button>
                  </div>
                ) : (
                  <button className="btn accent" style={{ marginTop: 6 }} onClick={() => { setShowConnect(false); vnaConnect(); }}>
                    Connect NanoVNA
                  </button>
                )}
                <div className="hint help-text">
                  Web Serial (Chrome/Edge). Enters VNA tune mode and locks RF; connect the generator too
                  and it auto-arms so you can drive the AIT with the VNA. N-type must be on the VNA.
                </div>
              </div>

              <div className="connect-version mono">
                UI {UI_VERSION}
                {health ? ` · operator ${health.version}` : reachable ? "" : " · operator offline"}
                {" · API "}
                {UI_API_VERSION}
                {health?.api_version ? `/${health.api_version}` : ""}
              </div>
            </div>
          ) : null}
        </div>
  );
}
