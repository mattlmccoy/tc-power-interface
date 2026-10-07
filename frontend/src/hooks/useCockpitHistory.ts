// Live cockpit history: one CockpitSample per new generator telemetry timestamp, kept for the
// timeline, part rate and run stats. Called once at App level so the history survives tab switches.
// Read-only: nothing here sends a command.

import { useEffect, useState } from "react";

import { appendSample, sampleFromStatus, type CockpitSample } from "../lib/cockpit/history.ts";
import type { Status } from "../lib/telemetry.ts";

/** 4 h at ~2 Hz telemetry. */
export const HISTORY_MAX = 4 * 3600 * 2;

export function useCockpitHistory(status: Status | null): CockpitSample[] {
  const [buf, setBuf] = useState<CockpitSample[]>([]);
  useEffect(() => {
    const s = sampleFromStatus(status);
    if (s) setBuf((b) => appendSample(b, s, HISTORY_MAX)); // same array back on a repeat = no re-render
  }, [status]);
  return buf;
}
