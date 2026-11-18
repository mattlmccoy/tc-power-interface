# Run clock: design + plan (2026-11-18)

## Intent
A per-run reminder clock. Matt types in the RF-on time the sims call for. The clock warns as the end
approaches and when it is reached, on screen and with chimes. **It is not automation: it never turns
RF on or off.** It must be easy to see and to find.

## Decided with Matt
- It counts **RF-on time** only and pauses while RF is off. Sim durations are heating time.
- It lives in the **top bar, on every page** (mockup option A): a chip next to "RF ON · run".
  Clicking the chip opens a pop-up: minutes:seconds entry, **Set**, **+1 min**, **Cancel**.
- Warnings: amber + one chime at **≤ 2 min** left; red + one chime at **≤ 30 s**. At **zero**: a
  fixed pop-up (no layout shift), a repeating chime until **Dismiss**, and the chip counts overtime
  ("+0:23 over").
- It is not tied to recordings. It stays set until cancelled or re-set (auto recordings can split
  while RF is off).
- Its chimes play even when the general alerts bell is off; there is a per-browser mute in the pop-up.
  Pressing Set is the click that unlocks browser audio.
- The run keeps a record: transitions go to the run's `events.json` while recording, and every
  telemetry row carries `clock_target_s` and `clock_on_s`. The setting happens before RF on, when the
  auto-recording has not started yet, so the rows are the reliable record.

## Approaches (my call; Matt said "build it")
1. **The operator holds the clock (chosen).** A pure `RunClock` is fed RF state on every controller
   poll, like `RfClock`. It keeps counting with the page closed, and every screen (lab Mac, phone,
   GitHub Pages) shows the same clock.
2. Browser only (localStorage + telemetry `rf_on`). Rejected: it stops counting when the tab sleeps
   or is closed, and two screens would disagree.
3. Reuse the auto-shutoff `TimerController`. Rejected: it commands RF off, which this must never do.

## Constraints
- Never actuate. `RunClock` gets numbers only and no controller handle.
- RF state unknown (no telemetry) = not counting, never counted as on.
- HARD UI rule: nothing that changes during a run may shift the layout. The chip has a fixed width,
  and the time's-up pop-up is `position: fixed`.
- Version 0.20.0 (minor). No deploy until Matt says so.

## Left to the builder
The chime voices (reuse `AlertAudio`; the overtime chime is gentler than the fault alarm), and
storing the state in memory only. If the operator restarts, the clock is lost; a restart also drops
the generator.

## Plan (red → green each)
1. `control/run_clock.py` `RunClock`: set / add / cancel / dismiss / update(now, rf_on) → events;
   snapshot(now) → `{set, target_s, on_s, remaining_s, phase, counting, dismissed}`.
2. App wiring: a poll listener, `/api/run-clock` GET/POST, `/add`, `/cancel`, `/dismiss`; `run_clock`
   in `/api/status`; events to the recorder; CSV columns `clock_target_s`, `clock_on_s`.
3. Frontend `lib/runClock.ts`: `fmtClock`, `parseClockEntry`, `chipView`, `soundFor` (edge-triggered).
4. `RunClockChip` (chip + pop-up), the time's-up pop-up, the `useRunClockSound` hook, and API calls.
   UI checked in a browser against a simulated operator; layout invariance measured.
