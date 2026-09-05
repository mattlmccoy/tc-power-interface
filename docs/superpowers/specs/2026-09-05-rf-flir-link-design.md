# RF ↔ FLIR event linkage — design spec

**Date:** 2026-09-05
**Status:** approved (brainstorm), pending spec review
**Repos touched:** `tc-power-interface` (this repo) and `flir-research-interface` (separate program)

## Goal

When the RF system is turned on or off, have the FLIR Research Interface record and annotate the
event: on RF ON, start a thermal recording (if not already recording) and write an "RF ON" event
mark; on RF OFF, write an "RF OFF" mark and — per a FLIR-side setting — either stop the recording
or keep it rolling to capture the cooldown. The two remain **separate programs** that talk over a
single HTTP contract.

## Non-goals (explicitly deferred)

- Closed-loop thermal control (FLIR temperature → RF power). Later phase; this feature is the
  event-linkage stepping stone toward it.
- Reverse direction (FLIR triggering RF). One-directional: RF → recording only.
- Multi-camera / multi-generator orchestration.

## Principles (firm)

1. **The link never blocks or trips RF.** Every FLIR call is best-effort: short timeout, off the
   RF control path, failures logged and surfaced in the T&C UI, never raised into the control loop.
2. **FLIR owns recording policy.** T&C reports RF truth; FLIR decides whether to start/stop/mark.
   The stop-vs-keep choice lives in FLIR's UI (user decision).
3. **Edge-triggered from telemetry**, not just button presses — so a protection-driven RF-off
   (fault) also fires, carrying its reason.

## Architecture

```
T&C operator (this repo)                         FLIR operator (separate repo)
  Controller poll loop
   └─ rf_on edge detector ──▶ FlirLink ──HTTP──▶ POST /api/rf-link/event
                               (best-effort)        └─ RF-link policy
                                                        ├─ event mark (always)
                                                        ├─ start recording (if auto_start & idle)
                                                        └─ stop recording (if stop_on_off & owned)
```

Only coupling is the JSON contract below. No shared code, no shared process.

## The contract

`POST /api/rf-link/event` (on the FLIR operator)

Request body:
```json
{
  "state": "on" | "off",
  "forward_w": 300.0,
  "reflected_fraction": 0.01,
  "reason": "operator" | "fault: <text>" | "...",
  "source_ts_ns": 1788613778139622000
}
```
- `state` required. Others optional/advisory (used in the mark text and metadata).

Response `200`:
```json
{ "recording": true, "run": "RF_20260905_090952", "action": "started|marked|stopped|kept", "detail": "..." }
```
Non-2xx or unreachable → T&C treats it as a link failure (logged + shown), RF unaffected.

## FLIR side (flir-research-interface)

New, small, isolated module — does **not** entangle with camera code.

- **Settings** (persisted JSON sidecar, mirroring FLIR's existing small-sidecar pattern such as
  `.storage.json`), exposed via `GET/PUT /api/rf-link/settings` and a compact "RF link" UI section:
  - `auto_start_on_rf_on: bool` (default **true**)
  - `stop_on_rf_off: bool` (default **false** = keep recording for cooldown)
- **Handler** for `POST /api/rf-link/event`:
  - `"on"`: write event mark `RF ON (<forward_w> W)`. If `auto_start_on_rf_on` and not currently
    recording → start a recording named `RF_<UTC>` with metadata `{trigger:"rf_link", forward_w,
    reflected_fraction}`; record that the link **owns** this run.
  - `"off"`: write event mark `RF OFF (<reason>)`. If `stop_on_rf_off` **and** the link owns the
    current run → stop it. Otherwise keep recording (cooldown).
  - If a recording was started by the operator (not link-owned), the link only adds marks and never
    stops it.
- **Event marks** reuse FLIR's existing recording-event mechanism (`POST /api/recording/event`
  writes into the run's `events.json`); start/stop reuse `POST /api/recording/start` / `/stop`.
- **UI:** a small section showing the two toggles + the last RF-link event received (state, time).

## T&C side (this repo)

- `integration/flir_link.py` — `FlirLink(base_url, timeout=1.0, enabled)`:
  - `notify(state, forward_w, reflected_fraction, reason)` builds the payload and POSTs it on a
    background worker with a short timeout; records `last_result` (ok/failed + message + ts).
    Never raises to the caller. Pure payload construction is unit-tested separately from the HTTP.
- **Edge detection** — a `RfLinkNotifier` attached to the `Controller` as a listener (the controller
  already invokes listeners each poll with a snapshot). It tracks the previous `rf_on` and, on a
  transition, calls `FlirLink.notify(...)`. RF-off `reason` = `"fault: <reasons>"` when the
  controller is in FAULT, else `"operator"`.
- **Config / enable (server-side state — the link lives in the backend, since edge detection is in
  the controller):**
  - `tcp-serve --flir-url <url>` sets the initial URL and enables the link at launch (absent = disabled).
  - `GET /api/flir-link` returns `{url, enabled, last_result}`; `POST /api/flir-link` updates
    `{url, enabled}` at runtime. The UI reads/writes these — it does not hold link state itself.
- **UI:** an "Instruments" panel: FLIR URL field, enable checkbox, and last-send status
  (ok/failed + time), driven by `GET/POST /api/flir-link`.

## Failure handling & edge cases

| Situation | Behavior |
|---|---|
| FLIR unreachable / slow on an RF edge | link marks failure (logged + UI); RF proceeds normally |
| FLIR camera not acquiring on RF-on | FLIR returns a non-2xx/`recording:false`; T&C shows "start failed"; RF proceeds |
| Rapid RF toggling | each edge posts; FLIR marks each; starts only if idle |
| Protection trip → RF off | edge detected; posts `state:"off", reason:"fault: <...>"`; FLIR marks (+ stops if configured) |
| Operator already recording before RF | link adds marks only; never stops an operator-owned run |
| Link disabled | no posts at all |

## Config / deployment

Both tools default to port 8000, so when linked run T&C on another port, e.g.
`tcp-serve --port 8010 --flir-url http://localhost:8000`. Server-to-server POSTs carry no `Origin`
header, so FLIR's cross-origin guard does not apply.

## Testing

- **FLIR side (TDD):** the RF-link policy handler against FLIR's recorder — `"on"` marks + starts
  when idle/auto-start; `"off"` marks + stops only when `stop_on_rf_off` and link-owned; keeps
  recording otherwise; operator-owned runs never stopped. Settings persistence round-trip.
- **T&C side (TDD):** edge detector emits exactly one notify per `rf_on` transition with the right
  state/reason (fault vs operator), using a fake link (no HTTP); `FlirLink` payload construction is
  pure-tested; the HTTP send is best-effort and swallows errors.
- **End-to-end:** run T&C (simulator) + FLIR (simulated camera) locally; toggle RF; confirm a FLIR
  run starts, `events.json` contains the RF ON/OFF marks, and stop-vs-keep honors the FLIR setting.

## Data-contract verification (before building the FLIR side)

Per the project's data-contract rule, confirm against the real FLIR code before coding the handler:
the exact `recording/start`/`/stop`/`/event` request+response shapes, how the recorder exposes
"is recording" and the current run name, and the existing settings-sidecar pattern to mirror. Cite
those in the plan; do not assume.

## Open defaults (confirmed)

- `stop_on_rf_off` default = **keep recording** (false). ✅ confirmed
- `auto_start_on_rf_on` default = **on** (true).
- Link disabled unless a FLIR URL is configured.
