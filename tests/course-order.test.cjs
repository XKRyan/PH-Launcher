"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/course-order.js"), "utf8");
const window = {};
vm.runInNewContext(source, { window });
const { move, apply } = window.courseOrder;

const courses = [
  { id: "c1", name: "Biology", grade: "6" },
  { id: "c2", name: "Economics", grade: "5" },
  { id: "c3", name: "English", grade: "7" },
];

// Values cross the vm realm boundary, so compare structurally via JSON.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

test("move inserts before and after the hovered card", () => {
  same(move(["a", "b", "c"], "c", "a", false), ["c", "a", "b"]);
  same(move(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
  same(move(["a", "b", "c"], "b", "b", true), ["a", "b", "c"], "dropping on itself is a no-op");
  same(move(["a", "b", "c"], "d", "zz", false), ["a", "b", "c", "d"], "an unknown drop target appends");
  same(move(null, "a", "b", false), ["a"]);
});

test("apply keeps a saved manual order and appends new courses by name", () => {
  same(apply(courses, ["c3", "c1"], "manual").map((course) => course.id), ["c3", "c1", "c2"]);
  same(apply([...courses, { id: "c9", name: "Art" }], ["c3", "c1"], "manual").map((course) => course.id), ["c3", "c1", "c9", "c2"]);
});

test("apply falls back to name and grade sorting when asked", () => {
  same(apply(courses, ["c3", "c1"], "name").map((course) => course.id), ["c1", "c2", "c3"]);
  same(apply(courses, ["c3", "c1"], "grade").map((course) => course.id), ["c3", "c1", "c2"]);
  same(apply(courses, [], "manual").map((course) => course.id), ["c1", "c2", "c3"], "no saved order means alphabetical");
});

test("apply never mutates the input array", () => {
  const input = [...courses];
  apply(input, ["c3"], "manual");
  same(input.map((course) => course.id), ["c1", "c2", "c3"]);
});
