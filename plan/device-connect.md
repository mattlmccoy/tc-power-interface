# Device connect — FLIR-style, real AG 0613, connect popover

Branch: `feat/device-connect`. From user (2026-09-07): "FLIR style connect but get rid of the sim.
Little pop out window to connect." Morning target: real AG 0613 over USB-serial.

## Root cause already fixed (separate, shipped): the webpage "won't connect" was a stale localStorage
`tcp.operator.v1 = http://localhost:8000` (FLIR's port). Real Chrome connects fine to :8010. The
operator-address field below makes that self-serviceable so it can't silently rot again.

## Design (low-risk, additive — keep 225 tests green)
- Controller gains runtime device swap: `attach_device(device, backend)` (connect=request-control +
  force-manual, start poll, state CONNECTED) and `detach_device()` (stop poll, RF off, release, close,
  device=None, state DISCONNECTED). Command methods guard when no device.
- `create_app(backend="simulated")` STILL auto-connects sim at boot (tests/dev unchanged). New
  `backend="none"` boots IDLE (no device) → UI shows connect popover. Production LaunchAgent → idle.
- Endpoints: `GET /api/discovery` (serial ports via `serial.tools.list_ports.comports()` + current
  connection), `POST /api/connect {port}` (attach serial on that port), `POST /api/disconnect`.
- SAFETY: connect never enables RF (RF defaults off). Real unit protocol UNVERIFIED → popover shows a
  "read-only until you enable RF; reconcile against the front panel" note. Auto-tuner still forbidden.
- Frontend: a compact **connect popover** (topbar button, not a full page). Scan → list ports →
  Connect; shows connected port + Disconnect. Operator-ADDRESS field lives here too (the :8010 base).
- Sim: kept in code for tests + my verification, NOT surfaced in the production popover; operator
  boots idle (no sim) in production.

## Tasks (TDD; verify each)
- [ ] T1 Controller `attach_device`/`detach_device` (+ guards). RED tests: attach→CONNECTED+polling;
      detach→DISCONNECTED+RF off+device None; command while detached raises. Refactor start/stop to reuse.
- [ ] T2 Lifespan `backend="none"` idle boot (controller built, features wired, NOT started). Test:
      status is disconnected, no telemetry, no crash.
- [ ] T3 `GET /api/discovery` → ports + current. Test with monkeypatched comports.
- [ ] T4 `POST /api/connect {port}` + `/api/disconnect` → attach/detach via controller. Test using a
      fake/sim transport injected (prove the swap end-to-end); connect leaves RF off.
- [ ] T5 Frontend connect popover (scan/connect/disconnect + operator-address field). Verify in real
      Chrome against the idle operator connecting to sim stand-in.
- [ ] T6 LaunchAgent → boot idle (`--backend none`); update install script. Rebuild dist, restart, verify.

## Gates: backend `uv run pytest` (keep 225+), frontend `npm test`+tsc, real-Chrome connect check.
## CANNOT test real serial tonight (generator unplugged) — the serial path is the same swap code with a
## SerialCxnTransport; user validates in the morning with `tcp-probe --serial <port>` FIRST (RF off).
