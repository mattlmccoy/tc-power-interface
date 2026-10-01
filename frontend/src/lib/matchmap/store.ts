// Saved match maps. A map file holds the measured points only (plus label, build, time); the fit is
// recomputed on load, so a saved map can never disagree with the current fitting code. The active map
// lives in this browser's localStorage (per origin: :8010 and GitHub Pages do not share it), and the
// same JSON is downloadable so it can be filed with the network's data and loaded elsewhere.

import { fitMap, solveMatch, type MapFit } from "./fit.ts";
import type { CapturedPoint } from "./capture.ts";

export const MAP_KEY = "tcp.matchmap.v1";
export const MAP_EVENT = "tcp-matchmap"; // same-tab notification after the active map changes
const KIND = "tcp-match-map";
const VERSION = 1;

export interface MapMeta { label: string; build: string; createdAt: string; points: CapturedPoint[] }
export interface LoadedMap extends MapMeta { fit: MapFit; coldMatch: { tune: number; load: number; gamma: number } }

export function serializeMap(m: MapMeta): string {
  return JSON.stringify({ kind: KIND, version: VERSION, ...m });
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

export function parseMap(text: string): LoadedMap {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { throw new Error("not a match map (unreadable JSON)"); }
  if (!raw || typeof raw !== "object" || raw.kind !== KIND) throw new Error("not a match map");
  if (raw.version !== VERSION) throw new Error(`unsupported match map version ${String(raw.version)}`);
  if (!Array.isArray(raw.points)) throw new Error("match map has no points");
  const points = raw.points.map((p: Record<string, unknown>, i: number) => {
    const g = p?.g as Record<string, unknown> | undefined;
    if (!num(p?.tune) || !num(p?.load) || !g || !num(g.re) || !num(g.im)) throw new Error(`point ${i} is malformed`);
    return p as unknown as CapturedPoint;
  });
  const fitPts = points.filter((p) => !p.repeat); // the repeat is a drift check, not extra map data
  const fit = fitMap(fitPts.length >= 4 ? fitPts : points);
  return {
    label: String(raw.label ?? ""), build: String(raw.build ?? ""), createdAt: String(raw.createdAt ?? ""),
    points, fit, coldMatch: solveMatch(fit),
  };
}

export function saveActiveMap(storage: Storage | null, text: string): void {
  try { storage?.setItem(MAP_KEY, text); } catch { /* storage unavailable: the map stays downloadable */ }
}

export function loadActiveMap(storage: Storage | null): LoadedMap | null {
  try {
    const text = storage?.getItem(MAP_KEY);
    return text ? parseMap(text) : null;
  } catch {
    return null;
  }
}
