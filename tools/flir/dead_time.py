"""Dead time θ between a power step and the part's response, from the real 10-02 fixture.

Cross-correlates dP/dt with d²T/dt² (the response to a step starts as a change in heating rate) over lags
0–60 s on the 5 s grid (negative lags printed as a diagnostic). Usage (repo root): python3 tools/flir/dead_time.py [roi] | --selftest
"""
import json
import sys

import numpy as np

FIXTURE = "backend/tests/fixtures/flir_20261002_125228_estimator.json"
DT = 5  # grid step, s


def lag_scores(p, temp, lags=range(-2, 13)):
    """Score the alignment of dP with d²T at each lag in grid steps (higher = better).

    Alignment: diff(p)[j] = p[j+1]-p[j] (step between samples j, j+1); diff(t,2)[j] = t[j+2]-2t[j+1]+t[j]
    is the heating-rate change across the same interval j -> j+1 that a zero-delay plant first shows.
    So lag 0 == no delay. (The first version used diff(t,2)[1:], which read one grid step late: the
    selftest recovered 20 s / 35 s for known 15 s / 30 s.)
    """
    p = np.asarray(p, float)
    t = np.convolve(np.asarray(temp, float), np.ones(3) / 3, mode="same")
    dp, d2t = np.diff(p), np.diff(t, 2)
    n = min(len(dp), len(d2t))
    dp, d2t = dp[:n], d2t[:n]
    return {k: float(np.dot(dp[max(0, -k): n - max(0, k)], d2t[max(0, k): n - max(0, -k)])) for k in lags}


def selftest():
    """Recover known pure delays from a first-order plant driven by the fixture's own power steps."""
    p = np.array(json.load(open(FIXTURE))["forward_w"], float)
    ok = True
    for delay_s in (15, 30):
        d, tau, k = delay_s // DT, 120.0, 0.3
        temp = np.zeros(len(p))
        temp[0] = 20.0
        for i in range(len(p) - 1):
            pd = p[i - d] if i - d >= 0 else p[0]
            temp[i + 1] = temp[i] + DT / tau * (k * pd + 20.0 - temp[i])
        scores = lag_scores(p, temp, range(0, 13))
        got = max(scores, key=scores.get) * DT
        good = abs(got - delay_s) <= 5
        ok &= good
        print(f"selftest known {delay_s} s -> recovered {got} s {'OK' if good else 'FAIL'}")
    return ok


def main():
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    fix = json.load(open(FIXTURE))
    roi = sys.argv[1] if len(sys.argv) > 1 else "freehand_sample"
    p = np.array(fix["forward_w"])
    score = lag_scores(p, fix["rois"][roi])
    pos = {k: v for k, v in score.items() if k >= 0}  # decision uses lags 0..60 s; negative lags are diagnostic
    best = max(pos, key=pos.get)
    print(f"{roi}: theta ~ {best * DT} s (scores by lag -10..60 s: {[round(v, 2) for v in score.values()]})")
    print(f"power steps (|dP| >= 5 W): {int((np.abs(np.diff(p)) >= 5).sum())}")


if __name__ == "__main__":
    main()
