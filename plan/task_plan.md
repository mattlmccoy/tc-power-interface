# Fix pass: ramp/RF gate, layout shift, cap cutoff, gauge smoothing, serving

Branch: `fix/ramp-caps-gauge`. From user report (2026-09-07).

## Root causes (investigated, evidence-backed)

| # | Symptom | Root cause | Fix kind |
|---|---------|-----------|----------|
| 6 | Ramp counter starts before RF engaged | `RampController.tick()` advances on `running` alone; never checks `rf_on` (contradicts its own docstring). Listener app.py:247 ignores snapshot `rf_on`. | Backend logic (TDD) |
| 3 | Ramp status text appears → shifts toggle up | Status `<div class="hint mono">` is conditionally **mounted** after `.setpoint-ramp` (which has `margin-top:auto`) → reflow. | Frontend DOM/CSS (reserve space) |
| 4 | Text cut off in cap entries ("50.8"→"50.") | Native number spinner (~15px) + 20px padding on 62px box → ~27px usable < 32px ("50.8"). scrollW 75 vs clientW 62 for "100.0". | CSS |
| 5 | Analog gauges jump between readings | Needle polygon recomputed each render (no interpolation). | Gauge.tsx transform+transition (visual) |
| 1/2 | "Never serves to actual website"; settings won't save on the website | Architectural: Pages site IS live+current, but public https → http://localhost:8010 is client-blocked (`ERR_BLOCKED_BY_CLIENT`). `:8010` same-origin works (PUT→200; LaunchAgent running). | Explanation + recommend :8010 (no code bug) |

Principle from user: **anything added must not move anything from its original place** — reserve space, never mount-and-reflow. Applies beyond the ramp line.

## Tasks (ONE change at a time; verify before next)

- [x] **T6 (P0)** Gate ramp on RF. `tick(dt, *, rf_on=False)` holds while RF off; listener passes `rf_on`. +2 tests. **Backend 225 passed.** Verified LIVE at :8010: armed w/ RF off → output_w=0 (was climbing to 10).
- [x] **T3 (P0)** Ramp status line always in layout (blank when idle); `.ramp-badge` line-height:1 so it never grows the header. Verified: toggling shifts header 0px, content-below 0px.
- [x] **T4 (P1)** Killed native cap spinners + trimmed padding. Verified: overflow 0 for "50.8"/"100.0"/"48" (was 13px).
- [x] **T5 (P1)** Needle = rotated `<g>` + CSS transition (0.24s, respects reduced-motion). tsc clean; 41 frontend tests pass; needle angles correct.
- [x] **Rebuild** dist (index-VtNcevXm.js) + **restarted operator** (was running pre-fix code). Serves fresh dist; new backend live.
- [x] **Ship** merged to main (--no-ff), pushed 878b4f7..c11165c, branch deleted. Pages redeploy in progress.
- [x] **Explain** serving (1/2): see below — :8010 is the correct URL; Pages→localhost is client-blocked (ERR_BLOCKED_BY_CLIENT), not fixable server-side.

## Serving conclusion (issues 1 & 2)
- Pages site https://mattlmccoy.github.io/tc-power-interface/ IS live + current; repo public; Pages enabled; workflow green.
- Operator answers CORS + Private-Network-Access preflights for the Pages origin (verified via curl).
- BUT a public https page fetching http://localhost:8010 is blocked CLIENT-side (net::ERR_BLOCKED_BY_CLIENT) — mixed-content / PNA / privacy-extension territory. No server config fixes this; varies by browser.
- The operator already serves the identical UI SAME-ORIGIN at http://127.0.0.1:8010 (no CORS, no mixed content, no blockers; save = PUT 200). The always-on LaunchAgent IS running.
- **Recommendation:** use http://127.0.0.1:8010 as the real URL. For another device (lab tablet), bind operator to 0.0.0.0 and use http://<mac-LAN-ip>:8010 — still same-origin, still robust. GitHub Pages adds only fragility for a tool that needs the local operator anyway.

## Verification gates
- Backend: `uv run pytest` (was 223 green).
- Frontend lib: `npm test` (was 41 green).
- Browser: measured checks at 1440px on dev server; then confirm at :8010 after dist rebuild.
