# Rearrangeable dashboard panels: design

**Date:** 2026-10-07 · **Branch:** `feat/dashboard-layout` (off `main` @ b943f4a) · **Status:** design approved (approach A)

## Goal

Let the operator move dashboard panels within and between the two columns, for example to put the Sense loop
panel where Generator or History sit. Let them collapse panels they don't watch live. A collapsed
Generator panel still shows the internal temperature.

Out of scope: hiding panels, touch drag, more than two columns, server-side or shared layouts, and the other
pages (Settings, Closed loop, VNA).

## Current state (evidence)

- `frontend/src/pages/DashboardPage.tsx` renders `.main > .col × 2` with the panels hard-coded:
  - left column: Telemetry, RfPower, Generator, History, SenseLoop
  - right column: MatchingNetwork, MatchAid, MatchTuner, Timer, Recording
- Each panel renders its own `<section className="panel">` + `<h2>`.
- `GeneratorPanel.tsx` shows the internal temperature with `fmtTemp` and `tempBar(temp, 25, limits.temperature_c_trip)`. `tempBar` returns a fraction and a color.
- `lib/settings_store.ts` has `storeSettings`, `loadSettings` and `settingsStorage()` (localStorage, or null when unavailable).
- E-STOP, RF OFF and DISARM live in the top bar, outside `.main`. They are unaffected by this feature.

## Design

### Layout model (pure, `lib/layout.ts`)

```ts
type PanelId = "telemetry" | "rfpower" | "generator" | "history" | "senseloop"
             | "matchnet" | "matchaid" | "matchtuner" | "timer" | "recording";
interface Layout { left: PanelId[]; right: PanelId[]; collapsed: PanelId[] }
```

- `DEFAULT_LAYOUT` equals today's arrangement.
- `normalizeLayout(saved, known)`:
  - drops unknown ids and duplicates
  - appends known ids missing from both columns to the column they default to, in default order
  - unknown or corrupt input returns the default
- `movePanel(layout, id, toCol, toIndex)`: removes `id` from wherever it is and inserts it at `toIndex` in `toCol`. The index is clamped. Moving a panel onto itself is a no-op.
- `toggleCollapsed(layout, id)` and `resetLayout()`.
- Persistence: `loadLayout` and `saveLayout` use `settings_store` under the key `tcp.dashboardLayout.v1`. A null storage falls back to the default without crashing.

### Generator collapsed line (pure, `lib/layout.ts` or `lib/instrument.ts`)

`generatorSummary(t, limits)` returns `{ text, color }`:
- `"internal temp 41.2 °C"` using `fmtTemp`
- `color` is `tempBar(...)`'s color when limits are known, otherwise neutral
- `"internal temp —"` when there is no telemetry; never "0 °C"

### Rendering

- `components/DashPanel.tsx` wraps one panel element, so the panel components themselves are unchanged.
- It adds a small control cluster to the panel's top-right corner:
  - a grip handle `⠿`, `draggable`, with title "Drag to move"
  - a chevron to collapse or expand
- Collapsed, it renders a one-line `.panel` bar (`.panel-collapsed`) containing the panel title and, for Generator, the summary in its color. The children are not mounted, but nothing in the operator hook stops: polling, recording and scope logging continue. Only the display folds.
- Native HTML5 drag and drop:
  - Only the grip starts a drag, so inputs and buttons inside panels behave normally.
  - Drop targets are each panel (before or after, by pointer y relative to its midpoint) and the empty tail of each column.
  - A 2px amber insertion line (`--accent`) shows the drop point.
  - The drop calls `movePanel` and saves.
- `DashboardPage` maps `layout.left` and `layout.right` to `PanelId → element` through a registry built from the current props. The JSX for each panel element is the existing JSX, moved into the registry.
- A "Reset layout" text button sits at the bottom of the dashboard and restores `DEFAULT_LAYOUT`.

### Styling

Existing tokens and classes only (`.panel`, `--line`, `--muted`, `--accent`, Space Mono labels):
- the control cluster is muted and brightens on hover
- `.panel-collapsed` padding matches the panel header so collapsing doesn't jump the column
- while dragging, the source panel is dimmed (opacity 0.4)

## Error handling

Corrupt or old saved layouts are normalized, never thrown. Storage that is unavailable means the default
layout with no persistence. A drop with an unknown id is ignored.

## Testing

- Red-green TDD with `node --test` covering:
  - `normalizeLayout`: corrupt input, unknown and duplicate ids, a newly added panel id
  - `movePanel`: within a column, across columns, index clamping, onto itself
  - `toggleCollapsed` and the round-trip through load/save with a fake Storage
  - `generatorSummary`: normal, no telemetry, no limits
- Gates: `npm test`, `npm run build`.
- Browser check on a separate simulated instance (not the bench operator on :8010):
  - drag Sense loop into Generator's slot
  - drag across columns
  - collapse History and Generator, and check the temperature line
  - reload, and check the layout persists
  - Reset layout
  - inputs inside panels still accept text, i.e. no accidental drags
