import type { Operator } from "../hooks/useOperator.ts";
import { SITE_MODE } from "../lib/api.ts";
import { FlirLinkPanel } from "../components/FlirLinkPanel.tsx";
import { LoggingPanel } from "../components/LoggingPanel.tsx";
import { OperatorPanel } from "../components/OperatorPanel.tsx";
import { PulsePanel } from "../components/PulsePanel.tsx";
import { SafetyLimitsPanel } from "../components/SafetyLimitsPanel.tsx";
import { ThermalPlanPanel } from "../components/ThermalPlanPanel.tsx";

export function SettingsPage({ op }: { op: Operator }) {
  const { applyBase, applyFlirUrl, autoLog, baseInput, controllable, flirEnabled, flirLast, flirUrlInput, limForm, limitsStatus, pulse, pulseForm, saveLimits, saveThermalPlan, setAutoLog, setBaseInput, setFlirUrlInput, setLimForm, setPulseForm, setThermalForm, startPulse, stopPulse, textInputStyle, thermalForm, thermalPlanStatus, toggleFlirEnabled } = op;
  return (
        <div className="main">
          <div className="col">
            <SafetyLimitsPanel
              limitsStatus={limitsStatus}
              limForm={limForm}
              setLimForm={setLimForm}
              saveLimits={saveLimits}
            />

            <ThermalPlanPanel
              thermalPlanStatus={thermalPlanStatus}
              thermalForm={thermalForm}
              setThermalForm={setThermalForm}
              saveThermalPlan={saveThermalPlan}
            />

            <LoggingPanel autoLog={autoLog} setAutoLog={setAutoLog} />

            <FlirLinkPanel
              flirUrlInput={flirUrlInput}
              setFlirUrlInput={setFlirUrlInput}
              flirEnabled={flirEnabled}
              flirLast={flirLast}
              applyFlirUrl={applyFlirUrl}
              toggleFlirEnabled={toggleFlirEnabled}
              textInputStyle={textInputStyle}
            />

            {SITE_MODE ? (
              <OperatorPanel
                baseInput={baseInput}
                setBaseInput={setBaseInput}
                applyBase={applyBase}
                textInputStyle={textInputStyle}
              />
            ) : null}

            <PulsePanel
              controllable={controllable}
              pulse={pulse}
              pulseForm={pulseForm}
              setPulseForm={setPulseForm}
              startPulse={startPulse}
              stopPulse={stopPulse}
            />
          </div>
        </div>
  );
}
