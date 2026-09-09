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

export function App() {
  const op = useOperator();
  const {
    device, view, setView, showHelp, toggleHelp, pillState, showConnect, setShowConnect, ports,
    scanPorts, baseInput, setBaseInput, applyBase, setPorts, setConnectErr, connected,
    disconnectDevice, connectBusy, connectErr, connectPort, health, reachable, handshake, faulted,
    ctrl, toast, showStartup, setShowStartup, estop, rfOff, disarmDevice, armed,
  } = op;
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
        <span className="spacer" />
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
        />
      </header>

      <SafetyRail
        connected={connected}
        armed={armed}
        estop={estop}
        rfOff={rfOff}
        disarmDevice={disarmDevice}
      />

      <Banners handshake={handshake} faulted={faulted} ctrl={ctrl} />

      <ErrorBoundary key={view}>
        {() => (
          <>
            {view === "dashboard" ? (
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
