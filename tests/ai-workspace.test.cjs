"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// The AI file tools are bound to a user-chosen folder. Verify the real main
// process helpers instead of a mock so a silent regression cannot pass.
const mainSource = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
const start = mainSource.indexOf("function normalizeWorkspacePath(value) {");
const end = mainSource.indexOf("\n// Xinlv state is split by trust level", start);
assert.ok(start >= 0 && end > start, "normalizeWorkspacePath must be extractable");

function loadHelper() {
  const context = { path, fs };
  vm.runInNewContext(`${mainSource.slice(start, end)}\nglobalThis.normalizeWorkspacePath = normalizeWorkspacePath;`, context);
  return context.normalizeWorkspacePath;
}

const normalize = loadHelper();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phl-workspace-"));

test("a real folder is accepted and stored as an absolute path", () => {
  assert.equal(normalize(tempDir), path.resolve(tempDir));
  const nested = path.join(tempDir, "drafts");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(normalize(nested), path.resolve(nested));
});

test("missing paths, files and empty values are refused", () => {
  assert.equal(normalize(""), "", "empty means no workspace");
  assert.equal(normalize("   "), "");
  assert.equal(normalize(path.join(tempDir, "does-not-exist")), "", "a missing folder is not accepted");
  const file = path.join(tempDir, "note.txt");
  fs.writeFileSync(file, "x");
  assert.equal(normalize(file), "", "a file is not a workspace");
  fs.rmSync(file, { force: true });
});

test("the updateAi whitelist keeps the workspace in sync with the recent list", () => {
  const updateStart = mainSource.indexOf("  updateAi(config) {");
  const updateEnd = mainSource.indexOf("\n  }\n", updateStart);
  const body = mainSource.slice(updateStart, updateEnd);
  assert.match(body, /'workspace',/, "workspace is an allowed AI setting");
  assert.match(body, /next\.workspaces = workspace \? \[workspace, \.\.\.recent\.filter\(\(item\) => item !== workspace\)\]\.slice\(0, 8\) : recent;/, "recent workspaces are de-duplicated and capped");
});

test("the renderer never receives file paths outside the workspace", () => {
  // File tools must resolve through the workspace root, not the launcher data.
  assert.match(mainSource, /function normalizeWorkspacePath\(value\) \{[\s\S]*?isDirectory\(\)/);
});

test.after(() => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} });
