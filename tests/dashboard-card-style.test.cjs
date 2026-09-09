"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");

// The dashboard "open" buttons once collapsed to 36px wide because a leftover
// `.dashboard-card > button` rule outranked `.dashboard-card-open`, wrapping the
// label one character per line. Guard the CSS so it cannot regress silently.
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");

const ruleFor = (selector) => {
  const pattern = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const match = pattern.exec(css);
  return match ? match[1] : "";
};

test("the dashboard open button keeps its own sizing", () => {
  const rule = ruleFor(".dashboard-card-open");
  assert.ok(rule, ".dashboard-card-open must be defined");
  assert.match(rule, /white-space:\s*nowrap/, "the label must never wrap character by character");
  assert.match(rule, /width:\s*auto/, "the button sizes to its label");
  assert.match(rule, /height:\s*auto/);
  assert.match(rule, /flex:\s*0 0 auto/);
});

test("no generic child-button rule can shrink the dashboard open button", () => {
  assert.doesNotMatch(css, /\.dashboard-card\s*>\s*button\s*\{/, "the old 36px arrow-button rule must be gone");
});

test("every dashboard card renders a labelled open button", () => {
  const buttons = [...html.matchAll(/<button class="dashboard-card-open"[^>]*>([^<]+)</g)].map((match) => match[1].trim());
  assert.equal(buttons.length, 3, "one open button per dashboard card");
  for (const label of buttons) assert.match(label, /^打开/, `unexpected label: ${label}`);
  assert.deepEqual(buttons, ["打开我的课表", "打开我的课程", "打开平和邮箱"]);
});
