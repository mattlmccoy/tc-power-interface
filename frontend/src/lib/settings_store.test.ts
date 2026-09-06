import assert from "node:assert/strict";
import test from "node:test";

import { loadSettings, storeSettings } from "./settings_store.ts";

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
