const {test}=require('node:test'),assert=require('node:assert/strict'),{parseCourseUnits,parseCoreOverview}=require('../electron/school-data.cjs');
const card=(id,title='Exploring truth')=>`<div class="unit-component completed"><div class="unit-details"><div class="title-and-badge"><p class="h4"><a href="/student/classes/21/units/${id}/presentations#show_at_a_glance">${title}</a></p><span class="badge-label">SL</span></div><span class="label-start">Starts W1 Sep</span><div class="unit-duration">3 Weeks</div></div><div class="lessons"><div class="number">0</div>Lessons</div><div class="tasks"><div class="number">2</div>Tasks</div></div>`;
test('unit cards extract titles and metadata without page controls or concatenation',()=>{
 const result=parseCourseUnits(`<div class="units-tabs">Units Weekly Planner List View Weekly View ${card(1)}${card(1)}${card(2,'Writing project')}<p>Resources No resources in the unit</p></div>`,21);
 assert.equal(result.unitsStatus,'ready');assert.equal(result.units.length,2);assert.deepEqual(result.units.map(u=>u.title),['Exploring truth','Writing project']);
 assert.equal(result.units[0].tasks,2);assert.equal(result.units[0].lessons,0);assert.equal(result.units[0].state,'completed');assert.ok(!JSON.stringify(result.units).includes('Weekly Planner'));
});
test('foreign and wrong-class links are rejected; unrecognized and empty pages are distinct',()=>{
 assert.equal(parseCourseUnits(card(1).replace('/student/classes/21','https://elsewhere.invalid/student/classes/21'),21).units.length,0);
 assert.equal(parseCourseUnits(card(1),22).units.length,0);
 assert.equal(parseCourseUnits('<div class="units-list-tab">No units found</div>',21).unitsStatus,'empty');
 assert.equal(parseCourseUnits('<main>Changed site</main>',21).unitsStatus,'unavailable');
});
test('CAS sections preserve paragraphs and exclude forms',()=>{
 const result=parseCoreOverview('<h1>CAS</h1><div class="aims-and-goals"><p>First paragraph.</p><p>Second paragraph.</p><form>Account controls</form></div>','cas');
 assert.match(result.sections[0],/First paragraph\.\nSecond paragraph/);assert.ok(!result.sections[0].includes('Account controls'));
});

test('CAS overview does not repeat nested sections',()=>{
 const result=parseCoreOverview('<h1>CAS</h1><div class="card-body"><div class="aims-and-goals"><p>One unique goal.</p></div></div>','cas');assert.equal(result.sections.length,1);assert.equal(result.sections[0],'One unique goal.');
});
