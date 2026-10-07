# Scope fixtures (captured from real data — do not hand-edit)

Source: experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-10-06_sense-loop-double/
- core2_{10,50,90}W_*.csv, core1_3W_*.csv — SDS1202X-E FW 1.3.27 front-panel CSV saves, sense loop via PHA0150.
- powersweep_core2_telemetry.csv — TC-POWER telemetry.csv of the 5→90 W ramp (setpoint was NOT logged then).

Reference fit values come from running ramp_core2_fit.py's fit() on these exact files (2026-10-07):
| file | Vrms | resid | f0 | min | max | H2 (frac) | H3 (frac) |
|---|---|---|---|---|---|---|---|
| core2_10W | 27.4295 | 0.705242 | 1.356e7 | -40 | 40 | 0.00127811 | 0.00273698 |
| core2_50W | 50.149 | 0.666169 | 1.356e7 | -70 | 72 | 0.00264559 | 0.00143736 |
| core2_90W | 68.8334 | 0.792761 | 1.356e7 | -98 | 98 | 0.00449 | 0.00213115 |
| core1_3W | 15.2429 | 0.151211 | 1.356e7 | -21.6 | 22 | 0.00191701 | 0.00023558 |

## scope_replies_20261007_10W/ — real VISA replies (verified against real SDS1202X-E FW 1.3.27 replies 2026-10-07)

- Source: live capture 2026-10-07 by tools/scope/capture_replies.py, Siglent SDS1202X-E SDS1EEFC902067 FW 1.3.27,
  LAN `TCPIP0::192.168.7.50::INSTR` (pyvisa-py VXI-11), `CHDR OFF`.
- Rig state: RF on, forward 10.5 W, reflected 0.0 W, tune/load cap 20.8/13.7 %; probe ATTN 500, VDIV 50 V,
  OFST -6 V, TDIV 100 ns, SARA 1 GSa/s, TRMD AUTO.
- `replies.json` — query replies (*IDN?, C1:ATTN?, C1:VDIV?, C1:OFST?, TDIV?, SARA?, TRMD?).
- `wf_0.bin` … `wf_9.bin` — raw `C1:WF? DAT2` replies: `b"DAT2,#9000001400"` + 1400 int8 + `b"\n\n"`.
- `readings.json` — per-capture fit results with operator telemetry: Vrms 26.358–27.271 V (median 26.712),
  B_pk 2.77–2.87 mT, f0 13.559–13.560 MHz.
- `front_panel.csv` — scope front-panel CSV saved at the same steady state: Vrms 26.739 V by our fit
  (ratio to VISA median 1.0010); every sample lies on the decoded VISA 2 V code grid.
- RF-off observation (no file): codes -3/-2 decode to 0–2 V (~0 V within one 2 V step), confirming the -OFST sign.
