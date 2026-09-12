import { useEffect, useRef } from "react";
import { Banners } from "./components/Banners.tsx";
import { ConnectBar } from "./components/ConnectBar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { StartupModal } from "./components/StartupModal.tsx";
import { SafetyRail } from "./components/SafetyRail.tsx";
import { Toast } from "./components/Toast.tsx";
import { useOperator } from "./hooks/useOperator.ts";
import { ClosedLoopPage } from "./pages/ClosedLoopPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { VnaTuneView } from "./pages/VnaTuneView.tsx";
import { useVna } from "./hooks/useVna.ts";
import { useAudioAlerts } from "./hooks/useAudioAlerts.ts";
import { VERSION_LABEL, BUILD_ID, VERSION_FULL } from "./version.ts";

export function App() {
  const op = useOperator();
  const {
    device, view, setView, showHelp, toggleHelp, pillState, showConnect, setShowConnect, ports,
    scanPorts, baseInput, setBaseInput, applyBase, setPorts, setConnectErr, connected,
    disconnectDevice, connectBusy, connectErr, connectPort, health, reachable, handshake, faulted,
    ctrl, toast, showStartup, setShowStartup, estop, rfOff, disarmDevice, armed,
  } = op;
  const vna = useVna(op);
  const alerts = useAudioAlerts(op);
  const inVna = !!op.status?.vna_session?.active;
  // VNA mode: auto-arm the generator once so the AIT caps are drivable (RF stays interlocked off — the
  // arm gate never enables RF and the VNA session refuses enable_rf). A manual disarm afterwards sticks.
  const autoArmedRef = useRef(false);
  useEffect(() => {
    if (!inVna) { autoArmedRef.current = false; return; }
    if (connected && !armed && !autoArmedRef.current) {
      autoArmedRef.current = true;
      void op.armDevice();
    }
  }, [inVna, connected, armed]);
  return (
    <div className={`app ${showHelp ? "" : "help-off"}`}>
      <header className="topbar">
        <span className="brand">
          T<span className="amp">&amp;</span>C Power Interface
        </span>
        <span className="device">
          {device?.id ? `${device.id} · ${device.serial ?? ""}` : "no device"}
          {device?.frequency_hz ? ` · ${(device.frequency_hz / 1e6).toFixed(2)} MHz` : ""}
        </span>
        <span className="build" title={`${VERSION_FULL} — matches the 'build' field in saved logs`}>
          <span className="ver">{VERSION_LABEL}</span> · {BUILD_ID.split(" · ")[0]}
        </span>
        <span className="spacer" />
        {!inVna && (
          <span className="viewtabs">
            <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
              Dashboard
            </button>
            <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
              Settings
            </button>
            <button
              className={view === "closed-loop" ? "active" : ""}
              onClick={() => setView("closed-loop")}
            >
              Closed loop
            </button>
          </span>
        )}
        <button
          className={`help-toggle ${alerts.enabled ? "on" : ""} ${alerts.alarmActive ? "alarming" : ""}`}
          onClick={() => alerts.enable(!alerts.enabled)}
          title={
            alerts.enabled
              ? "Audible alerts ON — alarm on faults, chime on reflected-power warnings. Click to mute."
              : "Turn on audible alerts (alarm on faults, chime on reflected-power warnings)"
          }
        >
          {alerts.enabled ? "🔔" : "🔕"} Alerts
        </button>
        <button
          className={`help-toggle ${showHelp ? "on" : ""}`}
          onClick={toggleHelp}
          title={showHelp ? "Hide explanatory text" : "Show explanatory text"}
        >
          ? Help
        </button>
        <ConnectBar
          pillState={pillState}
          showConnect={showConnect}
          setShowConnect={setShowConnect}
          ports={ports}
          connectBusy={connectBusy}
          connectErr={connectErr}
          connected={connected}
          device={device}
          reachable={reachable}
          health={health}
          baseInput={baseInput}
          setBaseInput={setBaseInput}
          applyBase={applyBase}
          scanPorts={scanPorts}
          connectPort={connectPort}
          disconnectDevice={disconnectDevice}
          setPorts={setPorts}
          setConnectErr={setConnectErr}
          vnaConnect={() => void vna.connect()}
          vnaConnected={vna.connected}
          vnaEnd={() => void vna.endSession()}
        />
      </header>

      <div className="app-chrome">
        <SafetyRail
          connected={connected}
          armed={armed}
          estop={estop}
          rfOff={rfOff}
          disarmDevice={disarmDevice}
        />
        <Banners
          handshake={handshake}
          faulted={faulted}
          ctrl={ctrl}
          clearFault={op.clearFault}
          alarmActive={alerts.alarmActive}
          silence={alerts.dismiss}
          vnaSession={op.status?.vna_session}
        />
      </div>

      <ErrorBoundary key={inVna ? "vna" : view}>
        {() => (
          <>
            {inVna ? (
              <VnaTuneView op={op} vna={vna} />
            ) : view === "dashboard" ? (
              <DashboardPage op={op} />
            ) : view === "settings" ? (
              <SettingsPage op={op} />
            ) : (
              <ClosedLoopPage op={op} />
            )}
          </>
        )}
      </ErrorBoundary>

      <Toast toast={toast} />

      <StartupModal open={showStartup} onClose={() => setShowStartup(false)} />
    </div>
  );
}
