# Rearrangeable Dashboard Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator drag dashboard panels within and between the two columns and collapse them. A collapsed Generator panel still shows its internal temperature. The layout is saved per browser.

**Architecture:** A pure layout model in `lib/layout.ts` holds the logic (normalize, move, collapse, persist) and is TDD'd with `node --test`. A `DashPanel` wrapper adds a grip and a chevron, and renders a one-line bar when collapsed. Existing panel components are unchanged. `DashboardPage` builds a `PanelId → element` registry from its current JSX and renders `layout.left` and `layout.right`.

**Tech Stack:** React 18 + TypeScript, native HTML5 drag and drop, `node --test`, Vite.

**Spec:** `docs/superpowers/specs/2026-10-07-dashboard-layout-design.md`

**Conventions:**
- Work only in the worktree `TC-POWER/.claude/worktrees/dashboard-layout` (branch `feat/dashboard-layout`).
- Frontend commands run from `frontend/`: `npm test`, `npm run build`. Run `npm ci` first if `node_modules` is missing.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.
- Column widths stay as they are: `.main` is `1fr 340px`. A wide panel dropped into the 340px right column will be narrow. That is the operator's choice, so don't change the grid.

---

### Task 1: Layout model (pure)

**Files:**
- Create: `frontend/src/lib/layout.ts`
- Test: `frontend/src/lib/layout.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  PANEL_IDS,
  loadLayout,
  movePanel,
  normalizeLayout,
  saveLayout,
  toggleCollapsed,
} from "./layout.ts";
import type { Layout } from "./layout.ts";

const fakeStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
};

test("default layout matches today's dashboard and contains every panel once", () => {
  assert.deepEqual(DEFAULT_LAYOUT.left, ["telemetry", "rfpower", "generator", "history", "senseloop"]);
  assert.deepEqual(DEFAULT_LAYOUT.right, ["matchnet", "matchaid", "matchtuner", "timer", "recording"]);
  assert.deepEqual([...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.right].sort(), [...PANEL_IDS].sort());
  assert.deepEqual(DEFAULT_LAYOUT.collapsed, []);
});

test("normalizeLayout: corrupt input falls back to the default", () => {
  assert.deepEqual(normalizeLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout("garbage"), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout({ left: 5, right: null }), DEFAULT_LAYOUT);
});

test("normalizeLayout: drops unknown + duplicate ids, appends missing panels to their default column", () => {
  const n = normalizeLayout({
    left: ["senseloop", "bogus", "telemetry", "telemetry"],
    right: ["recording"],
    collapsed: ["history", "nope", "history"],
  });
  assert.deepEqual(n.left.slice(0, 2), ["senseloop", "telemetry"]);
  // missing left-default panels appended in default order
  assert.deepEqual(n.left.slice(2), ["rfpower", "generator", "history"]);
  assert.deepEqual(n.right, ["recording", "matchnet", "matchaid", "matchtuner", "timer"]);
  assert.deepEqual(n.collapsed, ["history"]);
});

test("movePanel: within a column, across columns, clamped index, onto itself", () => {
  const a = movePanel(DEFAULT_LAYOUT, "senseloop", "left", 2);
  assert.deepEqual(a.left, ["telemetry", "rfpower", "senseloop", "generator", "history"]);
  const b = movePanel(DEFAULT_LAYOUT, "timer", "left", 0);
  assert.equal(b.left[0], "timer");
  assert.ok(!b.right.includes("timer"));
  const c = movePanel(DEFAULT_LAYOUT, "history", "right", 999);
  assert.equal(c.right.at(-1), "history");
  const d = movePanel(DEFAULT_LAYOUT, "generator", "left", 2);
  assert.deepEqual(d, DEFAULT_LAYOUT);
  assert.notEqual(a, DEFAULT_LAYOUT); // pure: returns a new object
  assert.deepEqual(DEFAULT_LAYOUT.left, ["telemetry", "rfpower", "generator", "history", "senseloop"]);
});

test("toggleCollapsed adds then removes", () => {
  const a = toggleCollapsed(DEFAULT_LAYOUT, "history");
  assert.deepEqual(a.collapsed, ["history"]);
  assert.deepEqual(toggleCollapsed(a, "history").collapsed, []);
});

test("save/load round-trip; unavailable storage gives the default", () => {
  const s = fakeStorage();
  const l: Layout = toggleCollapsed(movePanel(DEFAULT_LAYOUT, "senseloop", "left", 0), "generator");
  saveLayout(s, l);
  assert.ok(s.getItem(LAYOUT_KEY));
  assert.deepEqual(loadLayout(s), l);
  assert.deepEqual(loadLayout(null), DEFAULT_LAYOUT);
  s.setItem(LAYOUT_KEY, "{not json");
  assert.deepEqual(loadLayout(s), DEFAULT_LAYOUT);
});
```

- [ ] **Step 2: Run to verify failure.** Run `npm test` from `frontend/`. It should fail with `Cannot find module ... layout.ts`.

- [ ] **Step 3: Implement `frontend/src/lib/layout.ts`**

```ts
// Dashboard panel arrangement: which panels sit in which column, in what order, and which are folded.
// Pure — the DashboardPage renders from it; persisted per browser via settings_store.
import { loadSettings, storeSettings } from "./settings_store.ts";

export const PANEL_IDS = [
  "telemetry", "rfpower", "generator", "history", "senseloop",
  "matchnet", "matchaid", "matchtuner", "timer", "recording",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type Column = "left" | "right";
export interface Layout {
  left: PanelId[];
  right: PanelId[];
  collapsed: PanelId[];
}

export const LAYOUT_KEY = "tcp.dashboardLayout.v1";

export const DEFAULT_LAYOUT: Layout = Object.freeze({
  left: ["telemetry", "rfpower", "generator", "history", "senseloop"],
  right: ["matchnet", "matchaid", "matchtuner", "timer", "recording"],
  collapsed: [],
}) as Layout;

const isPanelId = (x: unknown): x is PanelId =>
  typeof x === "string" && (PANEL_IDS as readonly string[]).includes(x);

const defaultColumn = (id: PanelId): Column => (DEFAULT_LAYOUT.left.includes(id) ? "left" : "right");

/** Coerce anything (saved JSON, old versions) into a valid layout; never throws. */
export function normalizeLayout(raw: unknown): Layout {
  if (!raw || typeof raw !== "object") return clone(DEFAULT_LAYOUT);
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.left) || !Array.isArray(r.right)) return clone(DEFAULT_LAYOUT);
  const seen = new Set<PanelId>();
  const take = (arr: unknown[]): PanelId[] => {
    const out: PanelId[] = [];
    for (const x of arr) if (isPanelId(x) && !seen.has(x)) { seen.add(x); out.push(x); }
    return out;
  };
  const left = take(r.left);
  const right = take(r.right);
  for (const id of PANEL_IDS) {
    if (!seen.has(id)) (defaultColumn(id) === "left" ? left : right).push(id);
  }
  const collapsed = Array.isArray(r.collapsed)
    ? [...new Set(r.collapsed.filter(isPanelId))]
    : [];
  return { left, right, collapsed };
}

/** Move `id` to `toCol` at `toIndex` (clamped). Returns a new layout. */
export function movePanel(layout: Layout, id: PanelId, toCol: Column, toIndex: number): Layout {
  const left = layout.left.filter((x) => x !== id);
  const right = layout.right.filter((x) => x !== id);
  const target = toCol === "left" ? left : right;
  const i = Math.max(0, Math.min(Math.trunc(toIndex), target.length));
  target.splice(i, 0, id);
  return { left, right, collapsed: [...layout.collapsed] };
}

export function toggleCollapsed(layout: Layout, id: PanelId): Layout {
  const collapsed = layout.collapsed.includes(id)
    ? layout.collapsed.filter((x) => x !== id)
    : [...layout.collapsed, id];
  return { left: [...layout.left], right: [...layout.right], collapsed };
}

export function loadLayout(storage: Storage | null): Layout {
  return normalizeLayout(loadSettings<Layout>(storage, LAYOUT_KEY)?.v ?? null);
}

export function saveLayout(storage: Storage | null, layout: Layout): void {
  storeSettings(storage, LAYOUT_KEY, { v: layout, pending: false });
}

function clone(l: Layout): Layout {
  return { left: [...l.left], right: [...l.right], collapsed: [...l.collapsed] };
}
```

  Note: the "onto itself" test moves `generator` (index 2 in `left`) to `left` index 2. After filtering it out and re-inserting at 2, the order is unchanged, so `deepEqual` holds.

- [ ] **Step 4: Run to verify pass.** `npm test` should be all green (report the counts).
- [ ] **Step 5: Commit**: `git add frontend/src/lib/layout.ts frontend/src/lib/layout.test.ts && git commit -m "feat(layout): pure dashboard layout model (normalize, move, collapse, persist)"`

---

### Task 2: Generator collapsed summary (pure)

**Files:**
- Modify: `frontend/src/lib/layout.ts` (append)
- Test: `frontend/src/lib/layout.test.ts` (append)

- [ ] **Step 1: Failing tests** (append to `layout.test.ts`; add `generatorSummary` to the import)

```ts
test("generatorSummary: temp text + tempBar color; unknown is never 0 °C", () => {
  const s = generatorSummary({ temperature_c: 41.2 }, { temperature_c_trip: 60 });
  assert.equal(s.text, "internal temp 41.2 °C");
  assert.match(s.color ?? "", /^hsl\(/);
  assert.deepEqual(generatorSummary(null, { temperature_c_trip: 60 }), { text: "internal temp —", color: null });
  assert.deepEqual(generatorSummary({ temperature_c: 30 }, undefined), { text: "internal temp 30.0 °C", color: null });
});
```

- [ ] **Step 2: Run, see it fail** (`generatorSummary` is not exported).
- [ ] **Step 3: Implement** (append to `layout.ts`; add the imports at the top)

```ts
import { fmtTemp } from "./format.ts";
import { tempBar } from "./instrument.ts";

/** One-line summary for a collapsed Generator panel: the internal temperature (+ its bar color). */
export function generatorSummary(
  t: { temperature_c: number | null } | null | undefined,
  limits: { temperature_c_trip: number } | null | undefined,
): { text: string; color: string | null } {
  const temp = t?.temperature_c ?? null;
  const text = `internal temp ${fmtTemp(temp)}`;
  const color = temp != null && Number.isFinite(temp) && limits
    ? tempBar(temp, 25, limits.temperature_c_trip).color
    : null;
  return { text, color };
}
```

  Check the real `Telemetry` and `Limits` types in `lib/telemetry.ts`. If `temperature_c` is typed as non-null `number`, the structural parameter type above still accepts it.

- [ ] **Step 4: Run, see it pass.** **Step 5: Commit**: `feat(layout): collapsed Generator summary keeps internal temp visible`.

---

### Task 3: DashPanel wrapper, drag and drop, DashboardPage registry, reset

**Files:**
- Create: `frontend/src/components/DashPanel.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Modify: `frontend/src/styles.css` (append)

This is UI, so it isn't unit-testable. Its verification is the build plus the browser check in Task 4. All of its logic goes through Task 1 and Task 2 functions.

- [ ] **Step 1: `DashPanel.tsx`**

```tsx
import type { DragEvent, ReactNode } from "react";

import type { PanelId } from "../lib/layout.ts";

interface DashPanelProps {
  id: PanelId;
  title: string;
  collapsed: boolean;
  summary?: { text: string; color: string | null };
  dragging: boolean;
  dropMark: "before" | "after" | null;
  onToggle: (id: PanelId) => void;
  onDragStart: (id: PanelId) => void;
  onDragEnd: () => void;
  onDragOverPanel: (id: PanelId, where: "before" | "after") => void;
  onDropPanel: (id: PanelId, where: "before" | "after") => void;
  children: ReactNode;
}

function whereFrom(e: DragEvent<HTMLDivElement>): "before" | "after" {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
}

export function DashPanel(p: DashPanelProps) {
  return (
    <div
      className={`dash-panel${p.dragging ? " dragging" : ""}${p.dropMark ? ` drop-${p.dropMark}` : ""}`}
      onDragOver={(e) => { e.preventDefault(); p.onDragOverPanel(p.id, whereFrom(e)); }}
      onDrop={(e) => { e.preventDefault(); p.onDropPanel(p.id, whereFrom(e)); }}
    >
      <div className="dash-controls">
        <span
          className="dash-grip"
          draggable
          title="Drag to move"
          aria-label={`Move ${p.title} panel`}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id); p.onDragStart(p.id); }}
          onDragEnd={p.onDragEnd}
        >⠿</span>
        <button
          type="button"
          className="dash-chevron"
          aria-expanded={!p.collapsed}
          aria-label={`${p.collapsed ? "Expand" : "Collapse"} ${p.title}`}
          title={p.collapsed ? "Expand" : "Collapse"}
          onClick={() => p.onToggle(p.id)}
        >{p.collapsed ? "▸" : "▾"}</button>
      </div>
      {p.collapsed ? (
        <section className="panel panel-collapsed">
          <h2>{p.title}</h2>
          {p.summary ? (
            <span className="panel-summary mono" style={p.summary.color ? { color: p.summary.color } : undefined}>
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
```

- [ ] **Step 2: Append to `styles.css`**, using existing tokens only:

```css
.dash-panel { position: relative; }
.dash-panel.dragging { opacity: 0.4; }
.dash-panel.drop-before::before, .dash-panel.drop-after::after {
  content: ""; position: absolute; left: 0; right: 0; height: 2px; background: var(--accent); z-index: 3; }
.dash-panel.drop-before::before { top: calc(var(--space) * -2 - 1px); }
.dash-panel.drop-after::after { bottom: calc(var(--space) * -2 - 1px); }
.dash-controls { position: absolute; top: 10px; right: 12px; display: flex; gap: 4px; z-index: 2;
  opacity: 0.45; transition: opacity 120ms; }
.dash-panel:hover .dash-controls, .dash-controls:focus-within { opacity: 1; }
.dash-grip { cursor: grab; color: var(--muted); font-size: 14px; line-height: 1; padding: 2px 4px; user-select: none; }
.dash-grip:active { cursor: grabbing; }
.dash-chevron { background: transparent; border: 1px solid var(--line); border-radius: var(--radius);
  color: var(--muted); font-size: 11px; line-height: 1; padding: 2px 6px; cursor: pointer; }
.dash-chevron:hover { color: var(--fg); border-color: var(--line-control); }
.panel-collapsed { display: flex; align-items: baseline; gap: 8px; padding-right: 72px; }
.panel-collapsed h2 { margin: 0; }
.panel-summary { font-size: 12px; color: var(--muted); }
.col-tail { min-height: 40px; border-radius: var(--radius); }
.col-tail.drop-target { outline: 2px dashed var(--accent); outline-offset: -2px; }
.layout-reset { margin-top: calc(var(--space) * 2); text-align: right; }
.layout-reset button { background: none; border: none; color: var(--muted); font-size: 12px; cursor: pointer;
  text-decoration: underline; }
```

  Several panels already put controls at the right of their `<h2>` row (TelemetryPanel's "Analog gauges" toggle, SenseLoopPanel's buttons). The absolutely positioned `.dash-controls` must not cover them. In the browser check, look at every panel header. Where it overlaps, give that panel's `DashPanel` wrapper extra top padding via a `controlsInset` modifier class: add `className` prop support and style `.dash-panel.inset .dash-controls { top: -22px; }`, putting the controls just above the panel. Pick whichever looks clean, and document the choice in the commit message.

- [ ] **Step 3: `DashboardPage.tsx`**
  - Add state: `const [layout, setLayout] = useState<Layout>(() => loadLayout(settingsStorage()));`
  - Add an `update(l)` helper that does `setLayout(l); saveLayout(settingsStorage(), l);`
  - Add drag state: `dragId: PanelId | null` and `mark: { id: PanelId; where: "before" | "after" } | null`.
  - Build `const panels: Record<PanelId, { title: string; el: ReactNode; summary?: … }>`, moving each existing panel's JSX unchanged into its entry:
    - `telemetry: { title: "Telemetry", el: <TelemetryPanel … /> }`
    - `generator: { title: "Generator", el: <GeneratorPanel … />, summary: generatorSummary(t, limits) }`
    - …and so on for all 10 ids, using the exact JSX currently in the file.
  - Render the columns:

```tsx
const renderCol = (col: Column) => (
  <div className="col" key={col}>
    {layout[col].map((id) => (
      <DashPanel
        key={id}
        id={id}
        title={panels[id].title}
        collapsed={layout.collapsed.includes(id)}
        summary={panels[id].summary}
        dragging={dragId === id}
        dropMark={mark?.id === id && dragId !== id ? mark.where : null}
        onToggle={(pid) => update(toggleCollapsed(layout, pid))}
        onDragStart={setDragId}
        onDragEnd={() => { setDragId(null); setMark(null); }}
        onDragOverPanel={(pid, where) => setMark({ id: pid, where })}
        onDropPanel={(pid, where) => {
          if (!dragId || dragId === pid) { setDragId(null); setMark(null); return; }
          const targetCol: Column = layout.left.includes(pid) ? "left" : "right";
          const without = layout[targetCol].filter((x) => x !== dragId);
          const idx = without.indexOf(pid) + (where === "after" ? 1 : 0);
          update(movePanel(layout, dragId, targetCol, idx));
          setDragId(null); setMark(null);
        }}
      >{panels[id].el}</DashPanel>
    ))}
    <div
      className={`col-tail${dragId && mark === null ? " drop-target" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setMark(null); }}
      onDrop={(e) => { e.preventDefault(); if (dragId) update(movePanel(layout, dragId, col, layout[col].length)); setDragId(null); setMark(null); }}
    />
  </div>
);
```

  - Return `<><div className="main">{renderCol("left")}{renderCol("right")}</div><div className="layout-reset"><button type="button" onClick={() => update(resetLayout())}>Reset layout</button></div></>`
  - Add `export function resetLayout(): Layout { return normalizeLayout(DEFAULT_LAYOUT); }` to `layout.ts`, with a test (`assert.deepEqual(resetLayout(), DEFAULT_LAYOUT)` and `assert.notEqual(resetLayout(), DEFAULT_LAYOUT)`), red then green.
  - Preserve the existing `.main` wrapper semantics. If `.main` is the page's grid root with siblings, keep the reset row inside the page's existing container, not outside `.main` (check `App.tsx`).
- [ ] **Step 4:** `npm test && npm run build` must both pass. **Step 5: Commit**: `feat(ui): drag panels by grip, collapse to one line, reset layout`.

---

### Task 4: Browser verification, version bump, PR

- [ ] **Step 1:** Bump `frontend/package.json` to `0.17.2`. Rebuild with `npm run build`.
- [ ] **Step 2:** Start a separate simulated instance. Do NOT use :8010, which is the live bench.

```bash
cd backend && uv sync -q --extra dev && uv run tcp-serve --port 8033 --backend simulated --experiments-root <scratchpad>/experiments3
```

  Using the `mcp__Claude_Browser__*` tools on http://127.0.0.1:8033:
  - dismiss the startup modal
  - drag Sense loop's grip onto Generator's top half, and check Sense loop now sits above Generator
  - drag Timer from the right column into the left column
  - collapse History and Generator, and check the Generator line shows "internal temp …" (the simulator has a temperature)
  - reload, and check the layout persisted
  - click Reset layout, and check the default is back
  - type in an input inside a panel (e.g. the run name), and check no drag starts
  - screenshot each state

  Kill the 8033 server afterwards.
- [ ] **Step 3:** `git push -u origin feat/dashboard-layout`, then `gh pr create --repo mattlmccoy/tc-power-interface --base main --head feat/dashboard-layout` with a summary, test counts, screenshot notes, and ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
