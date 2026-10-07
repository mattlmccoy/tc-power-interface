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

scope_replies_*/ (added in Task 12) — raw VISA replies captured live from the scope.
