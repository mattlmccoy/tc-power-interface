# CXN serial protocol reference

Implemented in `backend/tc_power_interface/protocol/codec.py`. The source of truth is the
documented CXN command set (PyMeasure `tccxn.py`, MIT). **All of the below is captured from that
reference, not from our physical unit** — see "Data-contract status" at the end.

## Where T&C documents this

- T&C Download Center (`tcpowerconversion.com/software-downloads`) lists a **CXN GUI** and a
  **CXN Serial Port Programming Guide** (post-2017 revision), plus a separate **C9N** set —
  gated behind `support@tcpowerconversion.com`. A separate **GUI Software Guide** PDF exists.
- The CXN is rebranded by **AJA International as 0113 GTC / 0313 GTC** (same hardware) — an
  alternate documentation source.
- Open source: **PyMeasure** ships a complete CXN driver
  (`pymeasure/instruments/tcpowerconversion/tccxn.py`, MIT) — the protocol used here.

## Line settings

38400 baud, 8 data bits, 1 stop bit, no parity. Fixed in the device.

## Framing

Command (host → device), always 10 bytes:

```
'C' | address(1) | command(6) | checksum(2)
```

- `command` (6B) = 2-byte ASCII mnemonic + 2-byte param1 + 2-byte param2
- `checksum` = big-endian `uint16` sum of all preceding bytes
- After each command the device returns a 1-byte ack: `*` = OK, `?` = unrecognized.

Response (device → host), read after the ack byte:

```
'R' | address(1) | length(2, BE) | data(length) | checksum(2)
```

## Commands used by this tool

| Purpose | mnemonic / bytes | notes |
|---|---|---|
| Request control | `BC 55 55 00 00` | response `uint16`==1; **must poll/ping < 2 s or control is lost & RF disabled** |
| Release control | `BC 00 00 00 00` | resets safe defaults, RF off |
| Ping (keepalive) | `BP 00 00 00 00` | ack only |
| Power fwd/rev/load | `GP 00 00 00 00` | `>HHH`, each ÷10 = watts |
| Status/temp/mode/tuner | `GS 00 00 00 00` | status[0:2], temp[2:4]÷10, mode[4:6], tuner[6:8] |
| Tuner/DC block | `GT 00 00 00 00` | manual[0:2]&1, load[2:4]÷10, tune[4:6]÷10, dcV[6:8], preset[8:10] |
| Power limits | `Gp 00 00 00 00` | fwd limit[2:4]÷10, rev limit[18:20]÷10 |
| Identity / serial | `Gi 00 01 …` / `Gi 00 02 …` | `data.decode()[2:-1].strip()` |
| Firmware | `Gf 00 00 00 00` | `BBBB` → UI a.b / RF c.d |
| Frequency | `GF 00 00 00 00` | `>L` Hz |
| RF enable / disable | `BR 55 55 00 00` / `BR 00 00 00 00` | ack only |
| Setpoint (W) | `SA <hi> <lo> 00 00` | watts as big-endian `uint16` |
| Manual mode on/off | `TM 00 02 …` / `TM 00 01 …` | ack only |
| Load / tune capacity % | `TC 00 01 00 <p>` / `TC 00 02 00 <p>` | 0–100; requires manual mode |

Status bits (`GS` word): bit0 RF_ENABLED, bit4 EXTERNAL_RFSOURCE, bit5 LOAD_POWER_LEVELING,
bit6 MCG_MODE, bit8 FORWARD_POWER_LIMIT, bit9 REVERSE_POWER_LIMIT, bit10 OVER_TEMPERATURE,
bit11 INTERLOCK_OPEN, bit14 ANALOG_INTERFACE.

## Data-contract status (unverified against our unit)

- The installed generator is a **"blue-display" AG 0613 that appears to predate the CXN
  controller**. T&C publishes different guides per display generation. This dialect is a strong
  starting map but is **not confirmed** for our unit.
- `setpoint` unit ambiguity: the reference read path divides by 10 while the write path sends raw
  watts. The on-wire unit is unconfirmed; the prototype keeps setpoint writes gated and clamped.
- **Before any powered remote control**, run `tcp-probe --serial <port>` (read-only, RF off) and
  reconcile GP/GS/GT/Gp byte offsets and the setpoint unit against the front panel. Flag
  disagreements; do not silently trust. Obtain the revision-specific T&C guide if it does not match.
