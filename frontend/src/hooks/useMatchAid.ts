// In-run match aid state, held at App level so readings survive tab switches. Feeds every telemetry
// snapshot to the held-position tracker and runs "where did the match go" against the active cold map.
// Advisory only: nothing here sends a command.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Telemetry } from "../lib/telemetry.ts";
import { settingsStorage } from "../lib/settings_store.ts";
import { emptyTrack, trackSample, type Reading } from "../lib/matchmap/track.ts";
import { locateMatch, guide, type LocateResult, type AxisGuide } from "../lib/matchmap/locate.ts";
import { driftSample, driftSummary, emptyDrift, type DriftSummary } from "../lib/matchmap/drift.ts";
import { loadActiveMap, MAP_EVENT, MAP_KEY, parseMap, saveActiveMap, type LoadedMap } from "../lib/matchmap/store.ts";

export interface MatchAid {
  map: LoadedMap | null;
  readings: Reading[];
  result: LocateResult | null;
  guidance: { tune: AxisGuide; load: AxisGuide } | null;
  current: { tune: number; load: number } | null;
  err: string;
  loadFile: (f: File) => Promise<void>;
  clearReadings: () => void;
  drift: DriftSummary; // this run's own drift rate and cap travel left (works without a map)
  resetDrift: () => void;
}

export function useMatchAid(t: Telemetry | null): MatchAid {
  const [map, setMap] = useState<LoadedMap | null>(() => loadActiveMap(settingsStorage()));
  const [readings, setReadings] = useState<Reading[]>([]);
  const [err, setErr] = useState("");
  const trackRef = useRef(emptyTrack());
  const driftRef = useRef(emptyDrift());
  const [driftTick, setDriftTick] = useState(0);
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    const reload = () => setMap(loadActiveMap(settingsStorage()));
    const onStorage = (e: StorageEvent) => { if (e.key === MAP_KEY) reload(); };
    window.addEventListener(MAP_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(MAP_EVENT, reload); window.removeEventListener("storage", onStorage); };
  }, []);

  useEffect(() => {
    if (!t || t.host_timestamp_ns === lastTsRef.current) return;
    lastTsRef.current = t.host_timestamp_ns;
    const sample = {
      tMs: t.host_timestamp_ns / 1e6, rfOn: t.rf_on, fwd: t.forward_w, rev: t.reverse_w,
      tune: t.tune_cap_percent, load: t.load_cap_percent,
    };
    const next = trackSample(trackRef.current, sample);
    const d = driftSample(driftRef.current, sample);
    if (d.holds !== driftRef.current.holds || d.eWh !== driftRef.current.eWh) setDriftTick((n) => n + 1);
    driftRef.current = d;
    const prev = trackRef.current.readings;
    const same = next.readings.length === prev.length && next.readings.every((r, i) => r === prev[i]);
    if (!same) setReadings(next.readings); // expiry filtering makes a new array every sample
    trackRef.current = next;
  }, [t]);

  const result = useMemo(() => (map ? locateMatch(map.fit, map.coldMatch, readings) : null), [map, readings]);
  const current = t?.tune_cap_percent != null && t?.load_cap_percent != null
    ? { tune: t.tune_cap_percent, load: t.load_cap_percent } : null;
  const guidance = result && current ? guide(result, current) : null;
  const drift = useMemo(
    () => driftSummary(driftRef.current, { tune: t?.tune_cap_percent ?? null, load: t?.load_cap_percent ?? null, fwd: t?.forward_w ?? 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [driftTick, t?.tune_cap_percent, t?.load_cap_percent, t?.forward_w],
  );

  async function loadFile(f: File) {
    try {
      const text = await f.text();
      parseMap(text); // validate (and fit) before making it active
      saveActiveMap(settingsStorage(), text);
      setMap(loadActiveMap(settingsStorage()) ?? parseMap(text));
      setErr("");
    } catch (e) {
      setErr(`could not load map: ${(e as Error).message}`);
    }
  }

  function clearReadings() {
    trackRef.current = emptyTrack();
    setReadings([]);
  }

  function resetDrift() {
    driftRef.current = emptyDrift();
    setDriftTick((n) => n + 1);
  }

  return { map, readings, result, guidance, current, err, loadFile, clearReadings, drift, resetDrift };
}
