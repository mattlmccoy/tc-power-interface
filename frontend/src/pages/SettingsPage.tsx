import type { Operator } from "../hooks/useOperator.ts";
import { SITE_MODE } from "../lib/api.ts";
import { FlirLinkPanel } from "../components/FlirLinkPanel.tsx";
import { LoggingPanel } from "../components/LoggingPanel.tsx";
import { OperatorPanel } from "../components/OperatorPanel.tsx";
import { SafetyLimitsPanel } from "../components/SafetyLimitsPanel.tsx";
import { ThermalPlanPanel } from "../components/ThermalPlanPanel.tsx";

export function SettingsPage({ op }: { op: Operator }) {
  const { applyBase, applyFlirUrl, autoLog, baseInput, flirEnabled, flirLast, flirUrlInput, limForm, limitsStatus, saveLimits, saveThermalPlan, setAutoLog, setBaseInput, setFlirUrlInput, setLimForm, setThermalForm, textInputStyle, thermalForm, thermalPlanStatus, toggleFlirEnabled } = op;
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
          </div>
        </div>
  );
}
