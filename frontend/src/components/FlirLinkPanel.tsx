import type { CSSProperties } from "react";
import type { FlirLink } from "../lib/api.ts";
import { flirStatusLabel } from "../lib/format.ts";

interface FlirLinkPanelProps {
  flirUrlInput: string;
  setFlirUrlInput: (v: string) => void;
  flirEnabled: boolean;
  flirLast: FlirLink["last_result"] | null;
  applyFlirUrl: () => void;
  toggleFlirEnabled: (on: boolean) => void;
  textInputStyle: CSSProperties;
}

export function FlirLinkPanel(props: FlirLinkPanelProps) {
  const {
    flirUrlInput, setFlirUrlInput, flirEnabled, flirLast, applyFlirUrl, toggleFlirEnabled,
    textInputStyle,
  } = props;
  return (
            <section className="panel">
              <h2>FLIR link</h2>
              <label className="field-label" htmlFor="flir-url">
                FLIR operator URL
              </label>
              <input
                id="flir-url"
                className="mono"
                style={textInputStyle}
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
  );
}
