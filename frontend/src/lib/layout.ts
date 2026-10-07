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
  left: Object.freeze(["telemetry", "rfpower", "generator", "history", "senseloop"]),
  right: Object.freeze(["matchnet", "matchaid", "matchtuner", "timer", "recording"]),
  collapsed: Object.freeze([]),
}) as unknown as Layout;

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
    for (const x of arr) {
      if (isPanelId(x) && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    return out;
  };
  const left = take(r.left);
  const right = take(r.right);
  for (const id of PANEL_IDS) {
    if (!seen.has(id)) (defaultColumn(id) === "left" ? left : right).push(id);
  }
  const collapsed = Array.isArray(r.collapsed) ? [...new Set(r.collapsed.filter(isPanelId))] : [];
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

/** Fold or unfold a panel. Returns a new layout. */
export function toggleCollapsed(layout: Layout, id: PanelId): Layout {
  const collapsed = layout.collapsed.includes(id)
    ? layout.collapsed.filter((x) => x !== id)
    : [...layout.collapsed, id];
  return { left: [...layout.left], right: [...layout.right], collapsed };
}

/** The default arrangement, as a fresh mutable copy. */
export function resetLayout(): Layout {
  return normalizeLayout(DEFAULT_LAYOUT);
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

