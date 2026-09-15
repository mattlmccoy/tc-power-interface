// Operator update detection: is the local operator running OLDER code than the version this site was
// built from, and what command re-installs (updates + restarts) it. TC-POWER's operator is macOS-only
// (launchd + install.sh); there is no install.ps1, so only macOS gets a command — everything else is
// pointed at a manual update rather than a link that would 404.

export type Os = "mac" | "windows" | "linux" | "other";

const REPO = "https://raw.githubusercontent.com/mattlmccoy/tc-power-interface/main";

/** Parse "0.8.3" → [0,8,3]; null when it isn't a dotted numeric version (e.g. "dev", ""). */
function parse(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const nums = v.trim().split(".").map((p) => Number(p));
  return nums.length > 0 && nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
}

function cmp(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True only when both versions parse and the operator's is strictly older than the site's. Unknown,
 *  unparseable, equal, and operator-ahead all return false — never nag on uncertainty. */
export function operatorBehind(operatorVersion: string | null | undefined, siteVersion: string): boolean {
  const op = parse(operatorVersion);
  const site = parse(siteVersion);
  if (op === null || site === null) return false;
  return cmp(op, site) < 0;
}

export function detectOs(userAgent: string): Os {
  const ua = userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "other";
}

/** The update one-liner for an OS. Re-running install.sh git-pulls the repo and re-runs the service
 *  installer (which reloads the operator). macOS only — `command` is null on every other OS (there is
 *  no install.ps1 / Linux installer), so the banner shows a manual-update note instead. */
export function updateCommand(os: Os): { label: string; command: string | null } {
  if (os === "mac") {
    return { label: "macOS", command: `curl -fsSL ${REPO}/install.sh | bash` };
  }
  const label = os === "windows" ? "Windows" : os === "linux" ? "Linux" : "your OS";
  return { label, command: null };
}
