# Architecture & closed-loop plan

## Shape

```
CXN generator ──serial/USB──▶ Transport (simulated | serial)
                                   │  bytes
                             CxnDevice (codec framing, control lease)
                                   │  Telemetry / commands
                             Controller (poll thread = lease keepalive; protection dominant)
                                   │  snapshot()                         listener
                     ┌─────────────┼───────────────────────────┐         │
              FastAPI /api      /ws/telemetry (JSON)       guarded RF   Recorder
                     │             │                        commands   (experiments/…)
                     └──────▶ React/TS operator UI ◀─────────┘
```

Three data concerns are kept apart, as in the FLIR tool:

1. **Raw protocol** (`protocol/codec.py`) — pure bytes in/out, no IO.
2. **Device + control** (`device/`, `control/`) — the transport, the lease, telemetry, and the
   protection verdict. All device IO is serialized behind one lock.
3. **Presentation** (`api/`, `frontend/`) — never mutates control state except through the
   guarded command methods.

## Control layering (protection dominant)

From the 2026-09-05 handoff, three functions with strict priority:

1. **Protection** (`control/safety.py`, applied every poll by the controller) — the only authority
   that matters when RF integrity is in question. Pure function of one telemetry sample + limits +
   sample age → trip/hold. Trips on over-reflection (fraction and optional absolute watts),
   over-temperature (status flag or heat-sink limit), interlock, or stale telemetry / read error.
   A trip latches FAULT and commands RF off; RF-enable is refused while faulted.
2. **Match tracking** — *not built yet*. The future local Tune/Load tracker (bounded, true-power,
   reversible probes) will live in `control/`. The codec already exposes manual-mode + capacity
   commands; the controller exposes gated pass-throughs.
3. **Thermal trajectory** — seeded by `control/thermal.py` (advisory only) + `integration/
   flir_client.py` (parses the FLIR `/ws/frames` header for a control-ROI temperature). Wiring
   this to accepted-power commands is deferred until protection + match tracking are validated at
   true power.

## Why the loop is not closed yet (by design)

The mismatch of interest only appears after sustained high power as the nylon melts; a low-power
probe characterizes a different state. So the safe order (mirroring the handoff's staged plan):

1. Confirm the dialect read-only (`tcp-probe --serial`), reconcile against the panel.
2. Commission comms, actuator motion, RF-off latency, and the watchdog on a dummy load at low
   power.
3. Run advisory-only against the powder system (log what the thermal/match loops *would* command).
4. Enable bounded automatic power control at ≤150 W with the reflected-power trip active.
5. Only then add match-tracking and full thermal-trajectory control.

## Testing / verification

- Backend: `uv run pytest` (81 tests), `ruff check`, `mypy --strict`. A `hardware` pytest marker
  is reserved for physical-generator tests (none yet; deselected by default).
- Frontend: `npm test` (`node --test` on pure `lib/*.ts`), `tsc --noEmit`, `vite build`.
- The byte-level simulator lets the whole stack run and be integration-tested with no hardware;
  the live app was driven end-to-end against it (setpoint clamp, RF on/off, recording, WS stream).
