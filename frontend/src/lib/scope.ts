export interface ScopeReading {
  host_timestamp_ns: number;
  level_w: number | null;
  level_state: string;
  setpoint_w: number | null;
  forward_w: number | null;
  vrms_v: number | null;
  f0_hz: number | null;
  resid_v: number | null;
  vmin_v: number;
  vmax_v: number;
  h2_pct: number | null;
  h3_pct: number | null;
  b_pk_mt: number | null;
  attn: number;
  flags: string;
  valid: boolean;
}

export interface ScopeStatus {
  status: { running?: boolean; connected: boolean; error: string | null; rate_hz?: number | null };
  latest: ScopeReading | null;
  settings: Record<string, unknown>;
  stale?: boolean;
}

const DASH = "—";

export function scopeHeadline(st: ScopeStatus | undefined) {
  const r = st?.latest;
  if (!st || !st.status.connected || !r) {
    const why = st?.status.error ? ` · ${st.status.error}` : "";
    return { state: `scope: no data${why}`, vrms: DASH, b: DASH, f0: DASH, pkpk: DASH, h2: DASH, level: DASH };
  }
  if (st.stale) {
    return { state: "scope: stalled — no fresh data", vrms: DASH, b: DASH, f0: DASH, pkpk: DASH, h2: DASH, level: DASH };
  }
  return {
    state: `scope: live${st.status.rate_hz ? ` · ${st.status.rate_hz} Hz` : ""}`,
    vrms: r.vrms_v == null ? DASH : `${r.vrms_v.toFixed(1)} V`,
    b: r.b_pk_mt == null ? DASH : `${r.b_pk_mt.toFixed(2)} mT`,
    f0: r.f0_hz == null ? DASH : `${(r.f0_hz / 1e6).toFixed(3)} MHz`,
    pkpk: `${(r.vmax_v - r.vmin_v).toFixed(0)} V`,
    h2: r.h2_pct == null ? DASH : `${r.h2_pct.toFixed(2)} %`,
    level: r.level_w == null ? r.level_state.replaceAll("_", " ") : `${r.level_w} W`,
  };
}

const FLAGS: Record<string, { text: string; severity: "danger" | "caution" }> = {
  flux_stop: { text: "Flux at/above stop limit", severity: "danger" },
  probe_hard: { text: "Probe at/above hard voltage limit", severity: "danger" },
  probe_warn: { text: "Probe above warn voltage", severity: "caution" },
  clipped: { text: "Waveform clipped — reading invalid", severity: "danger" },
  attn_mismatch: { text: "Scope probe ×N ≠ setting", severity: "danger" },
  seating: { text: "Residual/H2 jumped — check clip seating", severity: "caution" },
  detune: { text: "V/√W falling at constant power — detune?", severity: "caution" },
};

export function flagLabel(f: string) {
  return FLAGS[f] ?? { text: f, severity: "caution" as const };
}

export interface LevelRow { level_w: number; n: number; vrms_median_v: number; b_median_mt: number | null }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function levelRows(readings: ScopeReading[]): LevelRow[] {
  const by = new Map<number, ScopeReading[]>();
  for (const r of readings) {
    if (!r.valid || r.level_w == null || r.vrms_v == null) continue;
    by.set(r.level_w, [...(by.get(r.level_w) ?? []), r]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([level_w, rs]) => {
    const bs = rs.map((r) => r.b_pk_mt).filter((b): b is number => b != null);
    return { level_w, n: rs.length, vrms_median_v: median(rs.map((r) => r.vrms_v as number)),
      b_median_mt: bs.length ? median(bs) : null };
  });
}
