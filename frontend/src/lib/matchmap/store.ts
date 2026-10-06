// Saved match maps. A map file holds the measured points only (plus label, build, time); the fit is
// recomputed on load, so a saved map can never disagree with the current fitting code. The active map
// lives in this browser's localStorage (per origin: :8010 and GitHub Pages do not share it), and the
// same JSON is downloadable so it can be filed with the network's data and loaded elsewhere.

import type { Complex } from "../vna/rf.ts";
import { fitMap, solveMatch, type MapFit } from "./fit.ts";
import type { CapturedPoint } from "./capture.ts";
import { shiftFit, solveAnchor, type AnchorShift } from "./anchor.ts";

export const MAP_KEY = "tcp.matchmap.v1";
export const MAP_EVENT = "tcp-matchmap"; // same-tab notification after the active map changes
const KIND = "tcp-match-map";
const VERSION = 1;

/** One VNA reading that re-anchors the map: Z at 13.56 MHz measured at this cap readback. Only the
 *  reading is stored; the shift is re-solved against the captured points on every load. */
export interface AnchorReading { tune: number; load: number; z: Complex; at: string }

export interface MapMeta { label: string; build: string; createdAt: string; points: CapturedPoint[]; anchor?: AnchorReading }
export interface LoadedMap extends MapMeta {
  fit: MapFit; // anchored when an anchor is present
  coldMatch: { tune: number; load: number; gamma: number };
  anchor?: AnchorReading & AnchorShift;
  anchorError?: string; // a stored anchor the map could not reproduce (map left unanchored)
}

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
  const base = fitMap(fitPts.length >= 4 ? fitPts : points);
  const meta = { label: String(raw.label ?? ""), build: String(raw.build ?? ""), createdAt: String(raw.createdAt ?? ""), points };
  const a = raw.anchor as Record<string, unknown> | undefined;
  const z = a?.z as Record<string, unknown> | undefined;
  if (a && num(a.tune) && num(a.load) && z && num(z.re) && num(z.im)) {
    const reading: AnchorReading = { tune: a.tune as number, load: a.load as number, z: { re: z.re as number, im: z.im as number }, at: String(a.at ?? "") };
    try {
      const sh = solveAnchor(base, reading, reading.z);
      const fit = shiftFit(base, sh.sT, sh.sL);
      return { ...meta, fit, coldMatch: solveMatch(fit), anchor: { ...reading, ...sh } };
    } catch (e) {
      return { ...meta, fit: base, coldMatch: solveMatch(base), anchorError: (e as Error).message };
    }
  }
  return { ...meta, fit: base, coldMatch: solveMatch(base) };
}

/** The same map file with `reading` as its (only) anchor — re-anchoring replaces, never stacks. */
export function anchorMapText(text: string, reading: AnchorReading): string {
  const raw = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({ ...raw, anchor: reading });
}

export function saveActiveMap(storage: Storage | null, text: string): void {
  try { storage?.setItem(MAP_KEY, text); } catch { /* storage unavailable: the map stays downloadable */ }
}

/** The active map's raw file text (to re-anchor it without losing anything), or null. */
export function loadActiveMapText(storage: Storage | null): string | null {
  try { return storage?.getItem(MAP_KEY) ?? null; } catch { return null; }
}

export function loadActiveMap(storage: Storage | null): LoadedMap | null {
  try {
    const text = storage?.getItem(MAP_KEY);
    return text ? parseMap(text) : null;
  } catch {
    return null;
  }
}
