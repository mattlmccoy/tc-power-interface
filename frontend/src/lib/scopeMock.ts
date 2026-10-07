/** Screenshot-only fixtures for the Sense loop panel. Referenced solely behind
 * `import.meta.env.MODE === "scopemock"` (a `vite build --mode scopemock` build), so production
 * builds tree-shake this module out. Values are the bench numbers the user supplied
 * (10/15/30 W -> 26.6/30.8/40.4 V, 2.80/3.23/4.25 mT); they are illustrative, not measurements. */

import type { ScopeReading, ScopeStatus } from "./scope.ts";
import type { Sample } from "./scopeView.ts";

const settings = {
  resource: "USB0::0xF4EC::0xEE38::SDSMMEBQ4R1234::INSTR", channel: 1, probe_attn: 500,
  core_label: "core 2", geometry: { turns: 1, cores_linked: 1, ae_per_core_m2: 1.1e-4 },
  limits: { probe_warn_v: 65, probe_hard_v: 70, flux_stop_mt: 6 },
  tol_w: 1, settle_s: 3, poll_interval_s: 0.2,
};

const LEVELS = [
  { w: 10, v: 26.6, b: 2.8 },
  { w: 15, v: 30.8, b: 3.23 },
  { w: 30, v: 40.4, b: 4.25 },
];

function reading(t_ns: number, lvl: (typeof LEVELS)[number] | null, jitter: number): ScopeReading {
  if (!lvl) {
    return { host_timestamp_ns: t_ns, level_w: null, level_state: "rf_off", setpoint_w: null,
      forward_w: 0, vrms_v: 0.04, f0_hz: 13.62e6, resid_v: 0.3, vmin_v: -0.6, vmax_v: 0.5,
      h2_pct: 42.54, h3_pct: 31.2, b_pk_mt: 0.004, attn: 500, flags: "", valid: true };
  }
  return { host_timestamp_ns: t_ns, level_w: lvl.w, level_state: "assigned", setpoint_w: lvl.w,
    forward_w: lvl.w + 0.4, vrms_v: lvl.v + jitter, f0_hz: 13.5601e6, resid_v: 0.41,
    vmin_v: -lvl.v * 1.41, vmax_v: lvl.v * 1.42, h2_pct: 0.21, h3_pct: 0.09,
    b_pk_mt: lvl.b + jitter * 0.1, attn: 500, flags: "", valid: true };
}

export function scopeMock(kind: string): { scope: ScopeStatus; readings: ScopeReading[]; samples: Sample[] } {
  const now = Date.now() * 1e6;
  const readings: ScopeReading[] = [];
  const samples: Sample[] = [];
  // 5 min history at 1 Hz: 10 W, 15 W, RF off gap, 30 W.
  for (let s = 300; s >= 0; s--) {
    const lvl = s > 220 ? LEVELS[0] : s > 150 ? LEVELS[1] : s > 110 ? null : LEVELS[2];
    const r = reading(now - s * 1e9, kind === "rfoff" && s < 20 ? null : lvl, Math.sin(s / 7) * 0.3);
    readings.push(r);
    const blank = r.level_state === "rf_off" || !r.valid;
    samples.push({ t_ns: r.host_timestamp_ns, v: blank ? null : r.vrms_v, b: blank ? null : r.b_pk_mt });
  }
  const latest = readings[readings.length - 1];
  return {
    scope: { status: { running: true, connected: true, error: null, rate_hz: 4.1 }, latest, settings, stale: false },
    readings, samples,
  };
}
