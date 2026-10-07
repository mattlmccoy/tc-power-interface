// The dials' scales and zones in words. Values only, no operator object: shared by the live strip and
// the read-only replay strip, so the replay's import graph never reaches the live controls.

/** Scales and zones of the dials, in words. Values only (shared with the read-only replay strip). */
export function DialNote({ powerCeil, fwdCaution, fwdDanger, maxRefl }: {
  powerCeil: number; fwdCaution: number | null; fwdDanger: number | null; maxRefl: number;
}) {
  return (
    <div className="ck-sub ck-dialnote">
      Requested = the last value written to the generator. Same dials as the Dashboard: 0–{powerCeil} W (generator limit), caution{" "}
      {fwdCaution ?? "—"} W, danger {fwdDanger ?? "—"} W · Reverse 0–{maxRefl} W, caution {maxRefl * 0.5}, danger {maxRefl * 0.8}.
    </div>
  );
}
