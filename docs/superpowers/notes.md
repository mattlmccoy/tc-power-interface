# Thermal closed-loop — verification notes

## Task 8: end-to-end sim convergence + disarm-on-fault (2026-09-05)

Driven over HTTP against a live `tcp-serve` on `:8010` (simulated backend), exactly as the UI does:
`POST /api/rf/enable` → `POST /api/thermal/arm` → `POST /api/thermal/start {mode:"auto"}` → poll
`/api/status`. Then tripped protection with a tight `max_reflected_w=1` and re-checked the loop.

Result (driver: `scratchpad/thermal_e2e.py`):

```
phase order: ramp -> approach -> soak -> cool -> done
  ramp     temp=  0.0  target=150  applied=None   (pre-first-tick)
  approach temp=147.8  target=150  applied=200
  soak     temp=158.4  target=150  applied=150
  cool     temp=143.8  target=150  applied=0      (soak_s=30 elapsed)
  done     temp= 48.0  target=150  applied=0      (< done_below_c=50)
max applied_w = 200 (loop ceiling 200)   ceiling violation: None

-- tripping protection (max_reflected_w=1) --
FAULT: state=fault  thermal.armed=False  thermal.applied_w=None

RESULT: PASS
```

**Safety invariants confirmed end-to-end:**
- Full trajectory `ramp → approach → soak → cool → done`; control temp reached the 150 °C target and
  cooled back below the done threshold.
- `applied_w` never exceeded the loop ceiling (peaked at exactly 200 W = ceiling).
- On a protection trip the loop **disarmed** (`armed=False`) and **stopped driving** (`applied_w=None`).
  The controller latched FAULT (`reflected power 1.2W > 1.0W`) and RF went off — the loop never
  re-enabled it.

**UI (browser-verified on the same server):** the Dashboard *Thermal control* panel showed the live
loop in `soak` — forward 100 W (RF on), control temp 161.3 °C → target 150 °C, applied 75 W (auto,
non-advisory), temp-vs-target gauge full; the History plot showed the ramp. The Settings *Thermal
plan* form rendered all six fields with their hard bounds (target 30–300, soak 0–3600, ceiling
0–400, approach 1–60, max step 1–50, done-below 25–200) and a Save button.

## Incidental fix found during Task 6
The Settings **Save limits** button was POSTing to a PUT-only route (`/api/safety-limits`), a silent
405 in merged code. Fixed by adding a `put()` client helper (now covered by `api.test.ts`, which
stubs `fetch` and locks each route's HTTP method). The same helper backs `saveThermalPlan`.

## Safety gap found during Task 5
`ThermalController.tick()` read `source.read().celsius` without checking `.valid`. A FLIR source with
no frame yet returns `valid=False, celsius=0.0`; the loop would have seen 0 °C, computed a huge
error, and ramped to the ceiling. Closed: the loop now backs off to 0 W and refuses to drive on an
invalid/stale reading (`test_invalid_temperature_does_not_drive`).
