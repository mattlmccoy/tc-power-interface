import assert from "node:assert/strict";
import test from "node:test";

import { COCKPIT_KEY, cockpitThresholds, loadSettings, saveCockpitThresholds, storeSettings } from "./settings_store.ts";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

test("storeSettings/loadSettings round-trips a pending value", () => {
  const s = fakeStorage();
  storeSettings(s, "k", { v: { max_forward_w: 300 }, pending: true });
  assert.deepEqual(loadSettings(s, "k"), { v: { max_forward_w: 300 }, pending: true });
});

test("loadSettings returns null for a missing key", () => {
  assert.equal(loadSettings(fakeStorage(), "nope"), null);
});

test("loadSettings returns null on corrupt JSON", () => {
  const s = fakeStorage();
  s.setItem("k", "{not json");
  assert.equal(loadSettings(s, "k"), null);
});

test("loadSettings returns null for a wrong-shape value", () => {
  const s = fakeStorage();
  s.setItem("k", JSON.stringify({ nope: 1 }));
  assert.equal(loadSettings(s, "k"), null);
});

test("null storage is a no-op / null (private mode)", () => {
  storeSettings(null, "k", { v: { a: 1 }, pending: false });
  assert.equal(loadSettings(null, "k"), null);
});

test("core warn thresholds: provisional defaults, bounded", () => {
  assert.equal(COCKPIT_KEY, "tcp.cockpit.v1");
  assert.deepEqual(cockpitThresholds(null), { tempC: 45, ratePerMin: 3, provisional: true });
  assert.deepEqual(cockpitThresholds({ tempC: 500, ratePerMin: -1 }), { tempC: 150, ratePerMin: 0.1, provisional: false });
});

test("core warn thresholds: bad fields fall back to their default; provisional only until one valid value is saved", () => {
  const D = { tempC: 45, ratePerMin: 3 };
  assert.deepEqual(cockpitThresholds({}), { ...D, provisional: true });
  assert.deepEqual(cockpitThresholds({ tempC: NaN, ratePerMin: Infinity }), { ...D, provisional: true });
  assert.deepEqual(cockpitThresholds({ tempC: "60" as unknown as number }), { ...D, provisional: true });
  assert.deepEqual(cockpitThresholds({ tempC: 60 }), { tempC: 60, ratePerMin: 3, provisional: false });
  assert.deepEqual(cockpitThresholds({ tempC: NaN, ratePerMin: 5 }), { tempC: 45, ratePerMin: 5, provisional: false });
  assert.deepEqual(cockpitThresholds({ tempC: 10, ratePerMin: 99 }), { tempC: 25, ratePerMin: 30, provisional: false });
});

test("storeSettings and saveCockpitThresholds report whether the value was actually stored", () => {
  assert.equal(storeSettings(fakeStorage(), "k", { v: { a: 1 }, pending: false }), true);
  assert.equal(storeSettings(null, "k", { v: { a: 1 }, pending: false }), false); // private mode / no storage
  const full = { ...fakeStorage(), setItem: () => { throw new Error("QuotaExceededError"); } } as Storage;
  assert.equal(storeSettings(full, "k", { v: { a: 1 }, pending: false }), false);
  assert.equal(saveCockpitThresholds(full, { tempC: 50, ratePerMin: 2 }), false);
  assert.equal(saveCockpitThresholds(fakeStorage(), { tempC: 50, ratePerMin: 2 }), true);
});
