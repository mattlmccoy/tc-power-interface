import type { CSSProperties } from "react";

interface OperatorPanelProps {
  baseInput: string;
  setBaseInput: (v: string) => void;
  applyBase: () => void;
  textInputStyle: CSSProperties;
}

export function OperatorPanel(props: OperatorPanelProps) {
  const { baseInput, setBaseInput, applyBase, textInputStyle } = props;
  return (
              <section className="panel">
                <h2>Operator</h2>
                <label className="field-label" htmlFor="op">
                  Local operator (tcp-serve) this UI connects to
                </label>
                <input
                  id="op"
                  className="mono"
                  style={textInputStyle}
                  value={baseInput}
                  onChange={(e) => setBaseInput(e.target.value)}
                  onBlur={applyBase}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyBase();
                  }}
                  placeholder="http://localhost:8010"
                />
              </section>
  );
}
