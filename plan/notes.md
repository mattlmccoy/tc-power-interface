# Notes: T&C CXN control interface

## Sources
- PyMeasure `tccxn.py` (MIT), offline copy read in full. This is the authoritative protocol
  spec used for the codec. Class `CXN` + `PresetChannel`. Line cites below refer to that file.
- T&C Download Center: CXN GUI + "Serial Port Programming Guide" exist but are gated behind
  support@tcpowerconversion.com. AJA rebrand = 0113 GTC / 0313 GTC (same hardware).
- Local RF handoffs (2026-09-03/04/05) in ../research/.../MANUAL_MATCHING_NETWORK/. They specify
  the three-layer control architecture (protection / match-tracking / thermal) this tool targets.

## CXN wire protocol (ground truth from tccxn.py)

### Serial
- 38400 baud, 8 data bits, 1 stop bit, no parity. Fixed in device. (tccxn.py:108-110,168)
- No read/write termination; framing is length-based. (tccxn.py:166-169)

### Command frame (host -> device), always 10 bytes
`b"C"` + address(1B) + command(6B) + checksum(2B)  (tccxn.py:181-186,228-236)
- header byte = `C` (0x43)
- address = 1 byte (device address; reference uses 0, "ignored")
- command (6B) = 2B command-id (ASCII mnemonic) + 2B param1 + 2B param2
- checksum = `struct.pack(">H", sum(all_preceding_bytes))` — bytewise sum, big-endian u16 (tccxn.py:171-179)
- After writing, device replies 1 ack byte: `*` (0x2A) = OK, `?` (0x3F) = unrecognized. (tccxn.py:188-198)

### Response frame (device -> host), read AFTER the ack byte
`b"R"`(0x52) + address(1B) + datalength(2B, BE) + data(datalength B) + checksum(2B) (tccxn.py:200-226)
- validate header[0]==0x52, header[1]==address, checksum over (header4 + data).

### Commands (6-byte command field). "%c" = a single value byte inserted at that position.
Reads (Instrument.measurement) — send command, parse `data`:
| Purpose | command (6B) | data parse |
|---|---|---|
| device id string | `Gi\x00\x01\x00\x00` | `data.decode()[2:-1].strip()` (tccxn.py:263-268) |
| serial number | `Gi\x00\x02\x00\x00` | same decode (270-275) |
| firmware ver | `Gf\x00\x00\x00\x00` | `struct.unpack("BBBB", data)` -> UI a.b, RF c.d (277-282) |
| pulse on/off | `GE\x00\x00\x00\x00` | `>HH` (284-288) |
| frequency Hz | `GF\x00\x00\x00\x00` | `>L` (290-294) |
| power fwd/rev/load W | `GP\x00\x00\x00\x00` | `>HHH` then each /10 (296-301) |
| status word | `GS\x00\x00\x00\x00` | `>H` of data[0:2] -> Status IntFlag (303-309) |
| heat-sink temp C | `GS\x00\x00\x00\x00` | `>H` of data[2:4] /10 (311-316) |
| operation mode | `GS...` | `>H` of data[4:6] {1:normal,3:pulse,4:ramp} (347-353) |
| tuner type | `GS...` | `>H` of data[6:8] {1:none,2:AFT,3:analog,4:digital} (318-325) |
| power_limit W | `Gp\x00\x00\x00\x00` | `>H` of data[2:4] /10 (327-332) |
| reverse_power_limit W | `Gp...` | `>H` of data[18:20] /10 (334-339) |
| dc_voltage V | `GT\x00\x00\x00\x00` | `>H` of data[6:8] (341-345) |
| manual_mode bool | `GT...` | (`>H` data[0:2]) & 1 (383-391) |
| load_capacity % | `GT...` | `>H` data[2:4] /10 (393-401) |
| tune_capacity % | `GT...` | `>H` data[4:6] /10 (403-411) |
| preset_slot | `GT...` | `>H` data[8:10] (413-420) |

Writes (Instrument.control set side):
| Purpose | write command (6B) | value encoding |
|---|---|---|
| rf_enabled | `BR%c%c\x00\x00` | ON=(0x55,0x55); OFF=(0x00,0x00) (422-430) |
| setpoint (W) | `SA%c%c\x00\x00` | int2char(watts): value.to_bytes(2,"big") (355-363) |
| operation_mode | `SO\x00%c\x00\x00` | {normal:1,pulse:3,ramp:4} (347-353) |
| ramp_start_power | `RP%c%c\x00\x00` | int2char (365-372) |
| ramp_rate | `RR%c%c\x00\x00` | int2char (374-381) |
| manual_mode | `TM\x00%c\x00\x00` | True->2, False->1 (383-391) |
| load_capacity % | `TC\x00\x01\x00%c` | 0..100 in last byte; needs manual_mode=True (393-401) |
| tune_capacity % | `TC\x00\x02\x00%c` | 0..100 in last byte; needs manual_mode=True (403-411) |
| preset_slot | `TP\x00%c\x00\x00` | 0..9 (413-420) |

Control lease (tccxn.py:432-455):
- `request_control` -> write `BC\x55\x55\x00\x00`, read response u16; expect 1.
- `release_control` -> write `BC\x00\x00\x00\x00`, read response u16; expect 0. Resets safe defaults, RF off.
- `ping` -> write `BP\x00\x00\x00\x00`.
- **Must poll a value or ping at least once per 2 s or control is lost and device resets
  setpoint / disables RF.** (tccxn.py:133-139) -> our Controller runs a keepalive.

### Status IntFlag bits (tccxn.py:238-261)
bit0 RF_ENABLED(1), bit4 EXTERNAL_RFSOURCE(16), bit5 LOAD_POWER_LEVELING(32), bit6 MCG_MODE(64),
bit8 FORWARD_POWER_LIMIT(256), bit9 REVERSE_POWER_LIMIT(512), bit10 OVER_TEMPERATURE(1024),
bit11 INTERLOCK_OPEN(2048), bit14 ANALOG_INTERFACE(16384).

## Data-contract status (per data-contract-verification rule)
- The above is CAPTURED FROM the pymeasure reference implementation, NOT from our physical unit.
  Test fixtures derived from it are "shape/spec-correct", not hardware-captured. Before any real-RF
  use, run a read-only capture (`tcp-probe --serial <port>`) and reconcile GS/GT/GP/Gp byte offsets
  and the setpoint unit against the front panel. Flag disagreements; do not silently trust.
- setpoint ambiguity: read path divides by 10 (device returns tenths?), write path sends raw watts
  via int2char (no x10). Unit on the wire is UNCONFIRMED. Prototype keeps setpoint write gated.

## FLIR conventions to mirror (from FLIR/backend/pyproject.toml, README, frontend)
- uv-managed backend package; hatchling build; `requires-python`; `[project.scripts]` entry points.
- Deps: fastapi>=0.115, uvicorn[standard], websockets, (numpy/etc as needed). Dev: pytest, ruff, mypy, httpx.
- pytest: testpaths=["tests"], addopts "-q", marker `hardware` deselected by default.
- ruff line-length 100, select E,F,I,B,UP,N,W. mypy strict, ignore_missing_imports.
- Backend package layout: `<pkg>/camera/base.py` (abstract backend + Frame), `camera/simulated.py`
  (sim), `acquisition/` service, `api/` FastAPI+WS, `recording/`, `playback/`, `analysis/`.
  -> mirror as: `device/base.py` (GeneratorBackend + Telemetry), `device/simulated.py`,
  `protocol/` (codec), `control/` (controller+safety), `api/` (server), `recording/`.
- Frontend: Vite+React+TS, `theme.css` tokens, `components/studio/` layout, `lib/` logic (unit-tested
  with `node --test`), vite proxy `/api`->:8000 and `/ws`->ws://:8000, base via VITE_BASE.
- Layout dirs: backend/ docs/ scripts/ frontend/ plan/ .

## Synthesized architecture for tc_power_interface
Three cooperating layers (from the 09-05 handoff), protection dominant:
1. Protection: fault/timeout/over-reflect/over-temp/interlock/comms-loss -> RF off. Watchdog.
2. Match tracker (LATER): bounded local Tune/Load search at true power; not in first prototype.
3. Thermal (LATER, needs FLIR): trajectory control from FLIR ROI temps.
Prototype scope: protocol + simulator + controller(control-lease) + protection + telemetry API + UI.
