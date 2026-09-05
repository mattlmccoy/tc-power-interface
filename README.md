# T&C Power Interface

Control, telemetry, and (future) closed-loop backend + UI for a **T&C Power Conversion
AG-series RF generator** (CXN serial dialect, 13.56 MHz), built for the RF-heating / sintering
experiments and intended to pair with the [FLIR Research Interface](../../../../FLIR) for
in-situ thermal closed-loop control. It mirrors the FLIR tool's architecture and conventions so
the two read as one family.

**Status (2026-09-05): working prototype against a built-in simulator.** Protocol codec,
byte-level device simulator, control-lease keepalive, protection/safety layer, FastAPI +
WebSocket telemetry API, run recording, and a React/TS operator UI are implemented and tested
(90 automated tests: 81 backend `pytest`, 9 frontend `node --test`). Real-hardware serial is
implemented but **opt-in and unproven on the physical unit** — see Safety below.

| Piece | Location | State |
|---|---|---|
| CXN wire-protocol codec (framing, checksum, commands, parsers) | `backend/tc_power_interface/protocol/codec.py` | tested (29) |
| Device abstraction + registry (`simulated` / `serial`) | `backend/.../device/` | tested (11 + 2) |
| Byte-level CXN simulator | `backend/.../device/simulated.py` | tested |
| High-level device wrapper | `backend/.../device/cxn.py` | tested |
| Protection/safety evaluator (pure) | `backend/.../control/safety.py` | tested (11) |
| Supervisory controller (lease keepalive + protection + guarded RF) | `backend/.../control/controller.py` | tested (11) |
| Advisory thermal evaluator (closed-loop seed) | `backend/.../control/thermal.py` | tested (4) |
| FLIR frame-header client (thermal input) | `backend/.../integration/flir_client.py` | parser tested (2) |
| Run recorder (`experiments/<ts>_<slug>/`, crash-detectable manifest) | `backend/.../recording/recorder.py` | tested (4) |
| FastAPI + `/ws/telemetry` API + `create_app` | `backend/.../api/` | tested (7); live-verified |
| Operator UI (live telemetry, gauge, plot, gated controls) | `frontend/` (Vite + React + TS) | logic tested (9); browser-verified |
| CLIs: `tcp-serve`, `tcp-probe` (read-only), `tcp-monitor` | `backend/.../api/server.py`, `probe.py`, `monitor.py` | run against the simulator |

## Scientific / engineering stance

Like the FLIR tool, this application uses **only the documented protocol** and never invents
device behaviour. The CXN command set is implemented from a documented reference (PyMeasure
`tccxn.py`, MIT). Reaching a real generator does **not** prove it speaks this dialect: the
installed "blue-display" AG 0613 unit *appears to predate* the current CXN controller, so every
byte-level assumption is marked unverified until a read-only hardware probe reconciles it against
the front panel. See `docs/protocol.md` and `plan/notes.md`.

**Safety.** RF output defaults OFF. There is no automatic RF-enable anywhere in this prototype —
only an explicit operator action enables RF, and it is refused while the protection layer is
latched in FAULT. The protection loop commands RF off on over-reflection, over-temperature,
interlock, telemetry timeout, or any read error. The default backend is the simulator; the real
serial transport is selected only with `--serial <port>`.

## Quick start (no hardware)

```bash
cd backend
uv sync --extra dev
uv run pytest                       # 81 tests
uv run tcp-probe --samples 5        # read-only telemetry from the simulator (RF stays off)
```

Run the full app (UI + API) against the simulator:

```bash
cd frontend && npm install && npm run build     # builds frontend/dist, served by the backend
cd ../backend && uv run tcp-serve                # http://127.0.0.1:8010 (8000 is FLIR)
# UI hot-reload during development:
cd frontend && npm run dev                       # http://127.0.0.1:5174 (proxies /api + /ws to :8010)
```

## Hosted UI (GitHub Pages)

The operator UI is also published at **https://mattlmccoy.github.io/tc-power-interface/** (a
static, site-mode build). It controls nothing on its own — it connects back to a **local** operator
you run on the machine wired to the generator:

```bash
cd backend && uv run tcp-serve      # API on 127.0.0.1:8010; allows the Pages origin by default
```

Open the hosted page, leave the `operator` field at `http://localhost:8010`, and it drives your
local generator. The operator is localhost-bound and only accepts cross-origin control from the
Pages origin carrying an `X-TCP-Client` header, so no other website can reach your RF hardware. Use
`tcp-serve --site-origin <origin>` to allow a different UI origin, or `--site-origin ''` to disable
it. CI (`.github/workflows/ci.yml`) runs the tests; `pages.yml` builds + deploys the site on push
to `main`.

## Talking to the real generator (opt-in, read-only first)

The RF handoffs prescribe read-only commissioning before any powered remote control:

```bash
cd backend
uv run tcp-probe --serial /dev/tty.usbserial-XXXX --samples 10 --output probe_report.json
```

Compare the printed identity and telemetry against the front panel. Only if they match does the
unit speak the CXN dialect; if not, obtain the revision-specific T&C programming guide
(support@tcpowerconversion.com) and adapt the codec. Then `tcp-serve --serial <port>` serves the
same UI driving the real unit — but review `docs/architecture.md` first.

## Layout

```
backend/    Python package `tc_power_interface` + tests (uv-managed)
  protocol/     CXN wire-protocol codec (pure)
  device/       transport ABC + registry, simulator, serial, CxnDevice wrapper
  control/      safety (protection), controller (lease + telemetry), thermal (advisory)
  recording/    run recorder
  integration/  FLIR thermal-stream client
  api/          FastAPI create_app + server entry point
frontend/   Vite + React + TypeScript UI (built into frontend/dist, served by tcp-serve)
docs/       protocol reference, architecture + closed-loop plan
plan/       task plan + research notes (protocol capture, data-contract status)
```

## License

MIT for this repository's own code. The CXN protocol is implemented from the MIT-licensed
PyMeasure reference; T&C's own GUI/firmware are proprietary and are not redistributed here.
