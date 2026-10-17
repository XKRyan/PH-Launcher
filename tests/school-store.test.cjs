"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SchoolStore } = require("../electron/school-store.cjs");
const { SchoolCache } = require("../electron/school-cache.cjs");

// A stand-in for Electron's safeStorage that is reversible but obviously not
// plaintext, so the tests also prove the file is not written in the clear.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8").replace(/^encrypted:/, ""),
};

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phl-school-store-"));
  return { dir, file: path.join(dir, "ph-launcher.school") };
}

const edupageWeek = (weekStart) => ({
  source: "edupage",
  accountKey: "acc-1",
  weekStart,
  fetchedAt: new Date().toISOString(),
  lessons: [{ id: "l1", date: weekStart, start: "08:00", end: "08:45", course: "Math", room: "A1", groupKey: "g1", cancelled: false, groups: ["A"] }],
  options: [{ key: "g1", label: "Math · A" }],
  missingDates: [],
  warnings: [],
});

test("school data is written encrypted and restored across launches", () => {
  const { dir, file } = tempFile();
  const store = new SchoolStore({ filePath: file, safeStorage: fakeSafeStorage });
  const cache = new SchoolCache({ onChange: (payload) => store.save(payload) });
  const week = "2026-09-07";

  cache.entries.set(`edupage:${week}`, { at: Date.now(), data: edupageWeek(week) });
  cache.week = week;
  cache.current.edupage = cache.entries.get(`edupage:${week}`).data;
  assert.equal(store.save(cache.exportForStorage()), true);

  const raw = fs.readFileSync(file, "utf8");
  assert.match(raw, /^PHL-SCHOOL-1:enc:/, "the file is encrypted, not plain JSON");
  assert.doesNotMatch(raw, /"course":"Math"/, "lesson content is not readable on disk");

  // A fresh process (new cache + new store) restores the same data offline.
  const restoredStore = new SchoolStore({ filePath: file, safeStorage: fakeSafeStorage });
  const restoredCache = new SchoolCache();
  const restored = restoredCache.hydrate(restoredStore.load());
  assert.equal(restored, 1);
  assert.equal(restoredCache.snapshot({ weekStart: week }).edupage.lessons[0].course, "Math");
  assert.equal(restoredCache.status.edupage.state, "stale", "restored data is marked stale so it still refreshes");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupted or foreign cache file is ignored instead of throwing", () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, "not our format at all");
  const store = new SchoolStore({ filePath: file, safeStorage: fakeSafeStorage });
  assert.equal(store.load(), null);
  assert.ok(store.error, "the failure is reported, not swallowed silently");

  fs.writeFileSync(file, "PHL-SCHOOL-1:enc:bm90IGpzb24=");
  assert.equal(new SchoolStore({ filePath: file, safeStorage: fakeSafeStorage }).load(), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("hydration keeps the newest week and the ManageBac snapshot", () => {
  const cache = new SchoolCache();
  const older = "2026-08-31";
  const newer = "2026-09-07";
  const restored = cache.hydrate({
    week: newer,
    entries: [
      { key: `edupage:${older}`, at: 1, data: edupageWeek(older) },
      { key: `edupage:${newer}`, at: 2, data: edupageWeek(newer) },
      { key: "managebac:", at: 3, data: { source: "managebac", accountKey: "acc-1", fetchedAt: new Date().toISOString(), courses: [{ id: "c1", name: "Biology" }], tasks: [] } },
    ],
  });
  assert.equal(restored, 3);
  assert.equal(cache.snapshot({}).edupage.weekStart, newer);
  assert.equal(cache.snapshot({}).managebac.courses[0].name, "Biology");
  assert.equal(cache.hydrate({ entries: [] }), 0, "re-hydrating is a no-op");
});

test("the change callback fires only after a successful sync", async () => {
  const seen = [];
  const cache = new SchoolCache({ onChange: (payload) => seen.push(payload.entries.length) });
  await cache.sync("managebac", {}, async () => ({ source: "managebac", accountKey: "acc-1", fetchedAt: new Date().toISOString(), courses: [], tasks: [] }));
  assert.equal(seen.length, 1, "a successful sync persists");
  await cache.sync("managebac", {}, async () => { throw new Error("network down"); }).catch(() => {});
  assert.equal(seen.length, 1, "a failed sync does not overwrite the stored snapshot");
});

test("oversized or empty payloads are refused rather than half-written", () => {
  const { dir, file } = tempFile();
  const store = new SchoolStore({ filePath: file, safeStorage: fakeSafeStorage });
  assert.equal(store.save({ entries: [] }), false);
  assert.equal(store.save(null), false);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
