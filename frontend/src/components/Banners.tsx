import type { Snapshot } from "../lib/telemetry.ts";
import type { Handshake } from "../lib/operator.ts";

interface BannersProps {
  handshake: Handshake | null;
  faulted: boolean;
  ctrl: Snapshot | undefined;
  vnaSession?: { active: boolean; stale: boolean; age_s: number | null };
}

export function Banners({ handshake, faulted, ctrl, vnaSession }: BannersProps) {
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
      {vnaSession?.active ? (
        <div className={`banner ${vnaSession.stale ? "warn" : "fault"}`}>
          <strong>VNA mode — RF disabled.</strong>
          {vnaSession.stale
            ? " Liveness lost — reconnect the NanoVNA or End the session."
            : " A NanoVNA session is active; end it to re-enable RF."}
        </div>
      ) : null}
    </>
  );
}
