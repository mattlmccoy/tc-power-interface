import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import { detectOs, operatorBehind, updateCommand } from "../lib/update.ts";
import { APP_VERSION } from "../version.ts";

const POLL_MS = 30_000;

/** Floating top-center banner shown ONLY when the local operator is running OLDER code than the
 *  version this site was built from — i.e. you're on the auto-deployed GitHub-Pages site but haven't
 *  updated your local operator. It shows the one command that updates + restarts the operator (macOS;
 *  other OSes get a "see the README" note since there is no install.ps1). Dismissal is remembered per
 *  site version, so the next release re-surfaces it. It self-suppresses on the operator-served UI,
 *  where the served build and the operator are the same version. */
export function UpdateBanner() {
  const [opVersion, setOpVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .health()
        .then((h) => {
          if (alive) setOpVersion(h.app_version ?? null);
        })
        .catch(() => {
          /* operator unreachable — leave version unknown, banner stays hidden */
        });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const key = `tcp.updateDismissed.${APP_VERSION}`;
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(key) === "1");
    } catch {
      /* private mode — treat as not dismissed */
    }
  }, [key]);

  if (dismissed || !operatorBehind(opVersion, APP_VERSION)) return null;

  const { label, command } = updateCommand(detectOs(navigator.userAgent));
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* private mode — dismiss for this session only */
    }
  };
  const copy = () => {
    if (!command) return;
    navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked — the command is visible to copy by hand */
      });
  };

  return (
    <div className="update-banner" role="status">
      <span className="msg">
        Operator update available — site is <b>v{APP_VERSION}</b>, your operator is running{" "}
        <b>v{opVersion}</b>.{" "}
        {command
          ? `Run this on the operator machine (${label}), then reconnect — it restarts itself:`
          : `Update it from the operator machine (${label}) — see the README for the steps.`}
      </span>
      {command ? (
        <>
          <code className="cmd">{command}</code>
          <button className="secondary" onClick={copy}>
            {copied ? "copied" : "copy"}
          </button>
        </>
      ) : null}
      <button className="x" aria-label="dismiss" title="dismiss until the next release" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
