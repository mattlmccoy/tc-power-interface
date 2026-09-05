# Settings & configurable safety limits — design spec

**Date:** 2026-09-05
**Status:** approved (brainstorm), pending spec review
**Repo:** `tc-power-interface` (this repo)

## Goal

Make the protection limits **operator-adjustable within hard bounds** and **persisted**, on a
dedicated **Settings page**; consolidate the FLIR-link + operator-base controls there; and stop the
T&C operator from colliding with FLIR on port 8000. This is also the safety foundation the later
in-situ closed loop will consume.

## Non-goals

- The in-situ closed loop (separate sub-project).
- Editing every internal limit — `telemetry_timeout_s` and the advisory `reflected_fraction_warn`
  stay fixed (not on the page).

## Safety principles (firm)

1. **Tighten-only.** Every editable limit is clamped server-side to a **hard bound**; the operator
   can always make protection *stricter*, but can never loosen it past the cap or exceed the
   hardware rating. Protection stays dominant; the RF-enable gate and the setpoint clamp use the
   live limits.
2. **Reflected protection trips on absolute Watts.** Damage tracks reflected *power*, not fraction
   (a high fraction at a few watts is harmless; watts is the physically correct limit, per the
   power-limits handoff). The reflected fraction is kept only for the gauge's advisory warn color,
   not as a trip.

## Editable limits (persisted to `.safety_limits.json` in the experiments root)

| UI label | field | default | hard bounds |
|---|---|---|---|
| Max forward power (setpoint ceiling) | `max_forward_w` | 350 W | 0–400 W |
| Max reflected power (trip) | `max_reflected_w` | 25 W | 1–200 W |
| Over-temperature shutoff | `temperature_c_trip` | 70 °C | 30–90 °C |

Fixed / advisory (not on the page): `reflected_fraction_warn` = 0.02 (gauge warn color),
`telemetry_timeout_s` = 1.5 s. Defaults/caps are conservative starting values to be tuned against
real hot-load data; they are operator-adjustable within the hard bounds.

## Backend

- **`SafetyLimits` refactor** (`control/safety.py`):
  - Rename `max_setpoint_w` → `max_forward_w`; replace the fraction trip with `max_reflected_w`
    (float, Watts, default 25); keep `reflected_fraction_warn` (advisory) and `telemetry_timeout_s`.
  - `evaluate()` trips reflected on `telemetry.reverse_w > limits.max_reflected_w` (drop the
    `reflected_fraction_trip` trip; keep the warn on fraction for the gauge). `clamp_setpoint` uses
    `max_forward_w`.
  - Add hard-bound clamping: a `SafetyLimits.bounded(max_forward_w, max_reflected_w,
    temperature_c_trip)` constructor/classmethod that clamps each field into its hard range (single
    source of truth for the bounds, reused by load + PUT).
- **Persistence** (`control/safety_store.py` or in `safety.py`): `load_limits(root)` reads
  `.safety_limits.json` (fallback to defaults, clamped); `save_limits(root, limits)` writes it. Same
  sidecar pattern as the FLIR rf-link settings.
- **`create_app`**: load persisted limits at startup and pass to the `Controller`.
- **`Controller.set_limits(limits)`**: swap `self.limits` under the state lock; `evaluate()` already
  reads `self.limits` each tick, so a change takes effect on the next poll.
- **API**: `GET /api/safety-limits` (current values + the hard bounds, so the UI can show/enforce
  them); `PUT /api/safety-limits` (validate+clamp to hard bounds, persist, `controller.set_limits`).
  Update the `limits` block in the status snapshot to expose `max_forward_w`, `max_reflected_w`,
  `temperature_c_trip`, `reflected_fraction_warn`.

## Frontend

- **Settings view**: a top-bar `Dashboard | Settings` toggle (simple `useState<"dashboard"|
  "settings">`; no router). The pill/device header stays visible on both.
- **Settings page** holds:
  - **Safety limits** form — three number inputs (max forward W, max reflected W, over-temp °C) with
    the hard-bound range shown as a hint, a Save button (PUT), and inline surfacing of a rejected
    (out-of-range) value using the server's message.
  - **FLIR link** (URL + enable + last-result) — moved from the dashboard Instruments panel.
  - **Operator base** (site mode) — moved from the top bar.
- **Dashboard** keeps telemetry / gauge / history / power / RF / matching / recording. The reflected
  gauge now reads against `max_reflected_w` — shows reflected in **Watts** with the trip marked and a
  warn zone at a fixed fraction (e.g. 50%) of the limit. `reflected_fraction_warn` continues to drive
  the advisory **warnings banner** in `evaluate()` (a soft warning when the fraction is high, never a
  trip), independent of the gauge.

## Port

- `tcp-serve` default `--port` → **8010** (README + docs updated) so it never collides with FLIR on
  8000. `--site-origin` default unchanged.

## Testing

- **Backend (TDD):** `SafetyLimits.bounded` clamps each field to its hard range; `evaluate()` trips
  when `reverse_w` exceeds `max_reflected_w` (and does NOT trip below it); `clamp_setpoint` honors
  `max_forward_w`; persistence round-trip; `GET/PUT /api/safety-limits` incl. out-of-range → clamped
  + a live-swap test (PUT a tighter limit, confirm the controller's limits changed). Update the
  existing `test_safety.py` / `test_controller.py` / `test_api.py` for the renamed fields.
- **Frontend:** any pure formatting/validation helper unit-tested (`node --test`); the view switch +
  settings form + moved panels are browser-verified.
- **End-to-end:** set a tight `max_reflected_w`, drive the simulator to exceed it, confirm the
  protection trips (RF off, FAULT) — proving edited limits take effect live.

## Migration note

Renaming `SafetyLimits` fields touches existing tests and the snapshot shape (the T&C UI reads
`limits.max_setpoint_w` today). All in-repo readers are updated in the same change; there are no
external consumers.
