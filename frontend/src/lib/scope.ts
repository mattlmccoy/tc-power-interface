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

export interface LevelRow {
  level_w: number; n: number; vrms_median_v: number; b_median_mt: number | null;
  /** median Vrms / sqrt(level), as backend analysis/scope_summary.py summarize_levels(). */
  v_per_sqrtw: number; h2_median_pct: number | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function levelRows(readings: ScopeReading[]): LevelRow[] {
  const by = new Map<number, ScopeReading[]>();
  for (const r of readings) {
    if (!r.valid || r.level_w == null || r.level_w <= 0 || r.vrms_v == null) continue;
    by.set(r.level_w, [...(by.get(r.level_w) ?? []), r]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([level_w, rs]) => {
    const bs = rs.map((r) => r.b_pk_mt).filter((b): b is number => b != null);
    const h2s = rs.map((r) => r.h2_pct).filter((h): h is number => h != null);
    const vmed = median(rs.map((r) => r.vrms_v as number));
    return { level_w, n: rs.length, vrms_median_v: vmed, b_median_mt: bs.length ? median(bs) : null,
      v_per_sqrtw: vmed / Math.sqrt(level_w), h2_median_pct: h2s.length ? median(h2s) : null };
  });
}
