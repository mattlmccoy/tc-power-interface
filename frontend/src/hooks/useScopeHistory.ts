// Sense-loop client history (trend samples + level-table readings). Called once at App level so the
// Dashboard's Sense loop trend survives a switch to the Closed-loop tab (the page unmounts on a tab
// switch; component-local buffers would reset). Read-only: nothing here sends a command.

import { useEffect, useState } from "react";

import { SCOPE_MOCK } from "../lib/scopeMockEnv.ts";
import type { ScopeStatus } from "../lib/scope.ts";
import { advanceScopeHistory } from "../lib/scopeView.ts";
import type { ScopeHistory } from "../lib/scopeView.ts";

export const SCOPE_SAMPLE_CAP = 6000; // 5 min at up to 20 Hz
export const SCOPE_READING_CAP = 2000;
const CAPS = { samples: SCOPE_SAMPLE_CAP, readings: SCOPE_READING_CAP };

export function useScopeHistory(real: ScopeStatus | undefined): ScopeHistory {
  const scope = SCOPE_MOCK?.scope ?? real;
  const [h, setH] = useState<ScopeHistory>(() => ({
    samples: SCOPE_MOCK?.samples ?? [],
    readings: SCOPE_MOCK?.readings ?? [],
  }));
  useEffect(() => {
    setH((prev) => advanceScopeHistory(prev, scope, CAPS)); // same object back on a repeat = no re-render
  }, [scope]);
  return h;
}
