# Vendored VNA library — provenance

`rf.ts`, `rf.test.ts`, `nanovna.ts`, `nanovna.test.ts` are copied verbatim from:

- Repo: https://github.com/mattlmccoy/nanovna-web
- Commit: `ded36f3527645561a0f2055fbef93e051eb6db5d` (2026-08-27)
- License: MIT, © 2026 Matthew McCoy (same owner as this repo).

Per the upstream `NOTICE.md`, nanovna-web's protocol behavior was *informed by* NanoVNA Saver
(GPL v3) but contains **no** NanoVNA Saver source. These vendored files are the MIT TypeScript
implementation only; copying them here carries no GPL obligation.

Do not edit the vendored files in place — re-sync from upstream if they change (rare for this
stable protocol/RF math), preserving these headers.

`touchstone.ts` is NOT vendored — it is a small local `.s1p` loader written for tests in this repo.

## Fixtures (real bench captures — do not invent S11)

Copied from `experiments/rf_sintering/MANUAL_MATCHING_NETWORK/2026-09-03_FULLCAP/` (research tree):

- `fixtures/detuned.s1p` ← `FULL_100ser_200sh_direct_8020MIX_fullcylinder_nanovna-sweep-1788456737951.s1p`
  (direct, no match; |Γ|@13.56 MHz ≈ 0.830, RL ≈ −1.6 dB).
- `fixtures/matched.s1p` ← `FULL_100ser_200sh_AIT_T1.46_L1.35_80200MIX_fullcylinder_nanovna-sweep-1788455240783`
  (AIT matched; |Γ|@13.56 MHz ≈ 0.064, RL ≈ −23.9 dB — passes the −20 dB convergence gate).

Both are Touchstone `# Hz S RI R 50` (frequency Hz, S11 real/imag, 50 Ω reference), 401 points,
10–18 MHz, 20 kHz grid, so 13.56 MHz (13 560 000) is an exact grid point.
