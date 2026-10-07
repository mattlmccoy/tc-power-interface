// The watched-core warn thresholds, read from this browser's saved Settings. Re-reads when the
// Settings panel saves in this tab (COCKPIT_EVENT) or another tab does (`storage`), so no reload.

import { useEffect, useState } from "react";
import { COCKPIT_EVENT, COCKPIT_KEY, cockpitThresholds, loadSettings, settingsStorage } from "../lib/settings_store.ts";

type Saved = { tempC?: number; ratePerMin?: number };
const read = () => cockpitThresholds(loadSettings<Saved>(settingsStorage(), COCKPIT_KEY)?.v ?? null);

export function useCockpitThresholds() {
  const [th, setTh] = useState(read);
  useEffect(() => {
    const reload = () => setTh(read());
    const onStorage = (e: StorageEvent) => { if (e.key === COCKPIT_KEY) reload(); };
    window.addEventListener(COCKPIT_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(COCKPIT_EVENT, reload); window.removeEventListener("storage", onStorage); };
  }, []);
  return th;
}
