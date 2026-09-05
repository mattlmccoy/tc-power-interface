import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { formatError } from "../lib/format.ts";

/** Renders the view via a callback so a throw happens inside THIS child's render (and is therefore
 *  caught by the boundary) rather than in the parent's inline JSX (which would escape it). */
function Rendered({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

interface Props {
  children: () => ReactNode;
}
interface State {
  error: unknown;
}

/** Catches render errors in a view so one bad panel shows a readable message instead of blanking
 *  the whole app to the background color. Key it by `view` so switching views remounts + recovers. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("UI render error:", error, info);
  }

  render(): ReactNode {
    if (this.state.error != null) {
      return (
        <div className="main">
          <div className="col">
            <section className="panel">
              <h2>This view failed to render</h2>
              <div className="hint mono">{formatError(this.state.error)}</div>
              <div className="hint">
                The rest of the app is still running — switch tabs, or reload. If this keeps
                happening, copy the message above so it can be fixed.
              </div>
              <button
                className="btn full"
                style={{ marginTop: "12px" }}
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            </section>
          </div>
        </div>
      );
    }
    return <Rendered render={this.props.children} />;
  }
}
