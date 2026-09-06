"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferTeachingGroups, subjectKey } = require('../src/school-selection-inference.js');

const option = (key, course, teacher = 'Teacher') => ({ key, course, label: `${course} · ${key} · ${teacher}` });

test('only verified personal identifiers can select teaching groups automatically', () => {
  const result = inferTeachingGroups({
    options: [option('geo-a', 'Geography1'), option('bio-a', 'Biology')],
    authoritativeKeys: ['geo-a'],
    authoritativeSource: 'verified-personal-id',
  });
  assert.deepEqual(result, { status: 'automatic', keys: ['geo-a'], ambiguous: [], unmatched: [] });
});

test('invalid or duplicated authoritative keys remain ambiguous', () => {
  const options = [option('geo-a', 'Geography1'), option('geo-a', 'Geography1', 'Other')];
  assert.deepEqual(inferTeachingGroups({ options, authoritativeKeys: ['geo-a'], authoritativeSource: 'verified-personal-id' }), {
    status: 'ambiguous', keys: [], ambiguous: ['geo-a'], unmatched: [],
  });
});

test('an exact ManageBac subject match is a suggestion, never an automatic selection', () => {
  assert.equal(subjectKey('IB Geography HL1'), 'geography');
  const result = inferTeachingGroups({ options: [option('geo-a', 'Geography1')], enrolledCourses: [{ name: 'IB Geography HL1' }] });
  assert.deepEqual(result, { status: 'suggestion', keys: ['geo-a'], ambiguous: [], unmatched: [] });
});

test('same-subject teaching groups require confirmation and yield no suggested key', () => {
  const result = inferTeachingGroups({
    options: [option('geo-a', 'Geography1', 'A'), option('geo-b', 'Geography2', 'B')],
    enrolledCourses: ['Geography HL'],
  });
  assert.deepEqual(result, { status: 'ambiguous', keys: [], ambiguous: ['geography'], unmatched: [] });
});

test('a single class option alone is not evidence of personal enrollment', () => {
  assert.deepEqual(inferTeachingGroups({ options: [option('geo-a', 'Geography1')] }), {
    status: 'none', keys: [], ambiguous: [], unmatched: [],
  });
});
