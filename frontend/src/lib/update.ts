// Operator update detection: is the local operator running OLDER code than the version this site was
// built from, and what command re-installs (updates + restarts) it. macOS uses install.sh (launchd
// service); Windows uses install.ps1 (per-user Scheduled Task + supervisor loop). Linux/other have no
// installer, so they get a manual note rather than a link that would 404.

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

/** The install/update one-liner for an OS. Re-running either installer git-pulls the repo and
 *  restarts the operator service. `command` is null on Linux/other (no installer), so the banner
 *  shows a manual-update note instead. */
export function updateCommand(os: Os): { label: string; command: string | null } {
  if (os === "mac") {
    return { label: "macOS", command: `curl -fsSL ${REPO}/install.sh | bash` };
  }
  if (os === "windows") {
    return { label: "Windows PowerShell", command: `irm ${REPO}/install.ps1 | iex` };
  }
  return { label: os === "linux" ? "Linux" : "your OS", command: null };
}
