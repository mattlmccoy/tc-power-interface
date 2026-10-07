// Wraps one dashboard panel with a move grip + collapse chevron. The wrapped panel component is
// unchanged; collapsed, it is unmounted and a one-line bar is shown instead (the operator hook keeps
// polling / recording regardless — only the display folds). Only the grip is draggable, so inputs and
// buttons inside the panel behave normally.
import type { DragEvent, ReactNode } from "react";

import type { PanelId } from "../lib/layout.ts";

export type DropWhere = "before" | "after";

interface DashPanelProps {
  id: PanelId;
  title: string;
  collapsed: boolean;
  summary?: { text: string; color: string | null };
  dragging: boolean;
  dropMark: DropWhere | null;
  onToggle: (id: PanelId) => void;
  onDragStart: (id: PanelId) => void;
  onDragEnd: () => void;
  onDragOverPanel: (id: PanelId, where: DropWhere) => void;
  onDropPanel: (id: PanelId, where: DropWhere) => void;
  children: ReactNode;
}

function whereFrom(e: DragEvent<HTMLDivElement>): DropWhere {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
}

export function DashPanel(p: DashPanelProps) {
  const cls = [
    "dash-panel",
    p.collapsed ? "is-collapsed" : null,
    p.dragging ? "dragging" : null,
    p.dropMark ? `drop-${p.dropMark}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      data-panel={p.id}
      onDragOver={(e) => {
        e.preventDefault();
        p.onDragOverPanel(p.id, whereFrom(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        p.onDropPanel(p.id, whereFrom(e));
      }}
    >
      <div className="dash-controls">
        <span
          className="dash-grip"
          draggable
          title="Drag to move"
          aria-label={`Move ${p.title} panel`}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", p.id);
            p.onDragStart(p.id);
          }}
          onDragEnd={p.onDragEnd}
        >
          ⠿
        </span>
        <button
          type="button"
          className="dash-chevron"
          aria-expanded={!p.collapsed}
          aria-label={`${p.collapsed ? "Expand" : "Collapse"} ${p.title}`}
          title={p.collapsed ? "Expand" : "Collapse"}
          onClick={() => p.onToggle(p.id)}
        >
          {p.collapsed ? "▸" : "▾"}
        </button>
      </div>
      {p.collapsed ? (
        <section className="panel panel-collapsed">
          <h2>{p.title}</h2>
          {p.summary ? (
            <span
              className="panel-summary mono"
              style={p.summary.color ? { color: p.summary.color } : undefined}
            >
              · {p.summary.text}
            </span>
          ) : null}
        </section>
      ) : (
        p.children
      )}
    </div>
  );
}
