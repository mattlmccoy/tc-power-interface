"""Watched ROIs (cores): value or a reason; the 60 s rate stays None until 60 s of data."""

from tc_power_interface.control.core_watch import MAX_WATCH, CoreWatch
from tc_power_interface.control.thermal_store import (
    _watch_list,
    load_source,
    save_source,
)


def _feed(c):
    return [
        {"name": "toroid_C", "mean_c": c, "valid": True},
        {"name": "toroid_D", "mean_c": None, "valid": False},
    ]


def test_value_reason_and_rate():
    w = CoreWatch()
    out = []
    for n in range(0, 140):  # 0.5 s ticks, +0.05 °C per tick = 6 °C/min
        out = w.update(n * 0.5, _feed(30.0 + 0.05 * n), ["toroid_C", "toroid_D", "toroid_X"])
        if n * 0.5 < 59.9:
            assert out[0]["rate_c_per_min"] is None  # needs 60 s of valid samples
    c, d, x = out
    assert c["status"] == "ok" and abs(c["rate_c_per_min"] - 6.0) < 0.05
    assert d == {"name": "toroid_D", "temp_c": None, "rate_c_per_min": None, "status": "invalid"}
    assert x["status"] == "not_in_feed" and x["temp_c"] is None


def test_an_invalid_sample_restarts_the_rate_window():
    w = CoreWatch()
    for n in range(130):
        w.update(n * 0.5, _feed(30.0 + 0.05 * n), ["toroid_C"])
    w.update(65.5, [{"name": "toroid_C", "mean_c": None, "valid": False}], ["toroid_C"])
    assert w.update(66.0, _feed(40.0), ["toroid_C"])[0]["rate_c_per_min"] is None


def test_non_finite_mean_is_invalid_not_a_number():
    w = CoreWatch()
    for bad in (float("nan"), float("inf")):
        feed = [{"name": "toroid_C", "mean_c": bad, "valid": True}]
        out = w.update(0.0, feed, ["toroid_C"])[0]
        assert out == {
            "name": "toroid_C",
            "temp_c": None,
            "rate_c_per_min": None,
            "status": "invalid",
        }


def test_removing_a_name_drops_its_history():
    w = CoreWatch()
    for n in range(130):
        w.update(n * 0.5, _feed(30.0 + 0.05 * n), ["toroid_C"])
    assert w.update(65.0, _feed(40.0), ["toroid_C"])[0]["rate_c_per_min"] is not None
    w.update(65.5, _feed(40.0), [])  # unwatched: history must go
    out = w.update(66.0, _feed(40.0), ["toroid_C"])[0]  # re-added: fresh window
    assert out["status"] == "ok" and out["rate_c_per_min"] is None


def test_watch_list_persists_with_the_source_and_is_bounded(tmp_path):
    assert load_source(tmp_path, default_type="flir") == {"type": "flir", "roi": None, "watch": []}
    both = ["toroid_C", "toroid_D"]
    save_source(tmp_path, {"type": "flir", "roi": "freehand_sample", "watch": both})
    assert load_source(tmp_path, default_type="simulated")["watch"] == ["toroid_C", "toroid_D"]
    save_source(tmp_path, {"type": "flir", "roi": None, "watch": ["a", "b", "c", "d", "e", 7]})
    assert load_source(tmp_path, default_type="flir")["watch"] == ["a", "b", "c", "d"][:MAX_WATCH]


def test_omitting_watch_keeps_the_stored_list_but_an_explicit_empty_clears_it(tmp_path):
    save_source(tmp_path, {"type": "flir", "roi": "r", "watch": ["toroid_C"]})
    save_source(tmp_path, {"type": "flir", "roi": "r2"})  # app.py callers pass only type + roi
    loaded = load_source(tmp_path, default_type="flir")
    assert loaded["watch"] == ["toroid_C"] and loaded["roi"] == "r2"
    save_source(tmp_path, {"type": "flir", "roi": "r2", "watch": []})
    assert load_source(tmp_path, default_type="flir")["watch"] == []


def test_rate_after_a_flat_start_uses_the_trailing_60s_window():
    w = CoreWatch()
    rates = {}
    for n in range(0, 241):  # 0.5 s ticks to t = 120 s: flat 30 C for 60 s, then +0.1 C/s
        t = n * 0.5
        c = 30.0 if t <= 60.0 else 30.0 + 0.1 * (t - 60.0)
        out = w.update(t, [{"name": "toroid_C", "mean_c": c, "valid": True}], ["toroid_C"])
        rates[t] = out[0]["rate_c_per_min"]
    # t=90: window is 30..90 s, only 30 s of it ramping -> +3 C over 60 s = 3 C/min.
    assert abs(rates[90.0] - 3.0) < 0.1
    # t=120: window is 60..120 s, fully ramping -> 6 C/min (a window kept from t=0 gives 3.6).
    assert abs(rates[120.0] - 6.0) < 0.1


def test_duplicate_watch_names_are_watched_once_each():
    w = CoreWatch()
    feed = [{"name": n, "mean_c": 30.0, "valid": True} for n in "abcd"]
    out = w.update(0.0, feed, ["a", "a", "b", "c", "d"])
    assert [o["name"] for o in out] == ["a", "b", "c", "d"]


def test_a_feed_entry_with_a_non_string_name_is_ignored():
    w = CoreWatch()
    feed = [
        {"name": ["x"], "mean_c": 1.0, "valid": True},
        {"name": "a", "mean_c": 30.0, "valid": True},
    ]
    out = w.update(0.0, feed, ["a"])
    assert out[0]["temp_c"] == 30.0 and out[0]["status"] == "ok"


def test_watch_list_dedupes_drops_empties_and_caps_at_four():
    assert _watch_list(["a", "a", "", "b", "c", "d", "e"]) == ["a", "b", "c", "d"]
