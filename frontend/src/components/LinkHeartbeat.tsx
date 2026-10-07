// GEN / APP link heartbeat LEDs for the top bar. Each LED re-mounts (key = its counter) on every new
// poll / message, which restarts a short CSS blink; its colour comes from the health tone.
import { appHealth, genHealth } from "../lib/heartbeat.ts";
import type { Health, LinkBlock } from "../lib/heartbeat.ts";

const APP_BLINK_EVERY = 5;

const TIP =
  "GEN: operator↔generator poll (the request is also the keepalive). " +
  "APP: browser↔operator updates. Green = fresh, amber = slow or a failed read, red = no data.";

function Led({ name, health, seq }: { name: string; health: Health; seq: number }) {
  return (
    <span className={`hb-item hb-${health.tone}`}>
      <span key={seq} className="hb-led" aria-hidden="true" />
      <span className="hb-name">{name}</span>
    </span>
  );
}

export function LinkHeartbeat({
  link,
  connected,
  msgSeq,
  msSinceMsg,
}: {
  link: LinkBlock | null | undefined;
  connected: boolean;
  msgSeq: number;
  msSinceMsg: number | null;
}) {
  const app = appHealth(msSinceMsg);
  // With no fresh status from the operator the GEN figures are a frozen copy: show them as unknown.
  const gen = genHealth(link, connected && app.tone === "ok");
  return (
    <span className="hb" title={TIP} aria-label={`GEN ${gen.tone} ${gen.label}, APP ${app.tone}`}>
      <Led name="GEN" health={gen} seq={link?.poll_seq ?? 0} />
      <span className="hb-age">{gen.label}</span>
      {/* Messages arrive at ~10 Hz, faster than the 150 ms blink: blink on every 5th (~2 Hz). */}
      <Led name="APP" health={app} seq={Math.floor(msgSeq / APP_BLINK_EVERY)} />
    </span>
  );
}
