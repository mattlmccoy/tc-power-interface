/** Pure display helpers for the Recording panel's "where is my run saved" line. */

export interface RecordingStatus {
  active: boolean;
  run: string | null;
  /** Absolute path of the recorder's current run dir (newer backends only). */
  run_path?: string | null;
  /** Absolute experiments root (newer backends only). */
  experiments_root?: string;
}

export interface RunItem { run: string; path?: string }

export interface SavedPath { label: "Saved to:" | "Runs save to:"; path: string; run: string | null }

/** Shorten a long path to `max` chars by eliding the middle, keeping both ends readable. */
export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

/** Which path to show: the active run, else the last run (from GET /api/recordings), else the
 * experiments root. null when the backend predates these fields (hide the line). */
export function savedPath(
  rec: RecordingStatus | undefined, lastRun: string | null, runs: RunItem[] | null,
): SavedPath | null {
  if (!rec) return null;
  if (rec.active && rec.run && rec.run_path) return { label: "Saved to:", path: rec.run_path, run: rec.run };
  const item = lastRun ? runs?.find((r) => r.run === lastRun && r.path) : undefined;
  if (item?.path) return { label: "Saved to:", path: item.path, run: item.run };
  if (rec.experiments_root) return { label: "Runs save to:", path: rec.experiments_root, run: null };
  return null;
}
