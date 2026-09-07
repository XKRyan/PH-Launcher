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

test('recognition keeps HL and SL distinct while supporting shared HL/SL groups', () => {
  const options = [option('sl', 'IB Biology SL'), option('hl', 'Biology HL2')];
  assert.deepEqual(inferTeachingGroups({ options, enrolledCourses: ['Biology Higher Level'] }).keys, ['hl']);
  assert.deepEqual(inferTeachingGroups({ options: [option('both', 'Biology HL/SL2')], enrolledCourses: ['Biology SL'] }).keys, ['both']);
  assert.deepEqual(inferTeachingGroups({ options: [option('sl', 'Biology SL')], enrolledCourses: ['Biology HL'] }).keys, []);
});

test('mathematics AA and AI match full course names without confusing pathways', () => {
  const options = [option('aa', 'Mathematics AA HL'), option('ai', 'Mathematics AI HL')];
  assert.deepEqual(inferTeachingGroups({ options, enrolledCourses: ['IB Mathematics: Analysis and Approaches HL'] }).keys, ['aa']);
  assert.deepEqual(inferTeachingGroups({ options, enrolledCourses: ['Maths Applications & Interpretation HL'] }).keys, ['ai']);
});

test('explicit teacher names disambiguate groups but missing teachers do not prove exclusion', () => {
  const options = [{ ...option('a', 'Geography'), teacher: 'Alex Wang' }, { ...option('b', 'Geography'), teacher: 'Casey Li' }];
  assert.deepEqual(inferTeachingGroups({ options, enrolledCourses: [{ name: 'Geography', teachers: ['Wang Alex'] }] }).keys, ['a']);
  options[1].teacher = '';
  assert.deepEqual(inferTeachingGroups({ options, enrolledCourses: [{ name: 'Geography', teachers: ['Wang Alex'] }] }).keys, []);
});

test('numbered groups and conflicting duplicate options are not silently merged', () => {
  assert.deepEqual(inferTeachingGroups({ options: [option('3', 'History (G3)'), option('4', 'History (G4)')], enrolledCourses: ['History (G3)'] }).keys, ['3']);
  assert.deepEqual(inferTeachingGroups({ options: [option('same', 'Biology'), option('same', 'Biology')], enrolledCourses: ['Biology'] }).keys, []);
});
