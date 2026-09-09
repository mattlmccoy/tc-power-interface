import type { Snapshot } from "../lib/telemetry.ts";
import type { Handshake } from "../lib/operator.ts";

interface BannersProps {
  handshake: Handshake | null;
  faulted: boolean;
  ctrl: Snapshot | undefined;
}

export function Banners({ handshake, faulted, ctrl }: BannersProps) {
  return (
    <>
      {handshake && handshake.level !== "ok" ? (
        <div className={`banner ${handshake.level === "refuse" ? "fault" : "warn"}`}>
          <strong>Version mismatch.</strong> {handshake.message}
        </div>
      ) : null}
      {faulted ? (
        <div className="banner fault">
          <strong>FAULT — RF disabled.</strong> {ctrl?.fault_reasons.join("; ")}
        </div>
      ) : ctrl && ctrl.warnings.length > 0 ? (
        <div className="banner warn">
          <strong>WARNING.</strong> {ctrl.warnings.join("; ")}
        </div>
      ) : null}
    </>
  );
}
