const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../electron/main.cjs'),'utf8');

test('workspace position is persisted with account scope and validates restored class and section',()=>{
 let persisted; const secureStore={data:{settings:{}},save(){persisted=JSON.parse(JSON.stringify(this.data));}};
 const schoolCache={edupage:{accountKey:'edu'},managebac:{accountKey:'mb',courses:[{id:'21'}]}};
 const context={secureStore,schoolCache,scheduleReminderTick(){},schoolSnapshot:()=>({}),Object,COURSE_REMINDER_OPTIONS:[]};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function updateSchoolPreferences('),source.indexOf('function ',source.indexOf('function updateSchoolPreferences(')+10)),context);
 const courseView={tab:'timetable',courseId:'',section:'overview',week:'2026-11-02',showWeekend:true,edupageAccount:'edu',managebacAccount:'mb'};
 context.updateSchoolPreferences({courseView});assert.equal(persisted.settings.schoolPreferences.courseView.tab,'timetable');
 context.updateSchoolPreferences({courseView:{...courseView,tab:'courses',courseId:'21',section:'tasks'}});
 assert.equal(persisted.settings.schoolPreferences.courseView.section,'tasks');
 for(const invalid of [{managebacAccount:'other'},{courseId:'999'},{section:'bogus'},{tab:'bogus'},{week:'garbage'}]) assert.throws(()=>context.updateSchoolPreferences({courseView:{...courseView,...invalid}}));
 context.schoolSnapshot=()=>({edupage:{accountKey:'shared-edu'},managebac:{accountKey:'shared-mb',courses:[{id:'22'}]}});
 context.updateSchoolPreferences({courseView:{...courseView,tab:'courses',courseId:'22',edupageAccount:'shared-edu',managebacAccount:'shared-mb'}});
 assert.equal(persisted.settings.schoolPreferences.courseView.courseId,'22');
 context.schoolSnapshot=()=>({});
 const before=JSON.stringify(secureStore.data); secureStore.save=()=>{throw Error('disk')};
 assert.throws(()=>context.updateSchoolPreferences({courseView}));assert.equal(JSON.stringify(secureStore.data),before);
});
test('manual class mapping is persisted with both account identities and rollback on failure',()=>{
 let persisted;const secureStore={data:{settings:{}},save(){persisted=JSON.parse(JSON.stringify(this.data));}};
 const schoolCache={edupage:{accountKey:'edu',lessons:[{groupKey:'g'}]},managebac:{accountKey:'mb',courses:[{id:'21'}]}};
 const context={secureStore,schoolCache,scheduleReminderTick(){},schoolSnapshot:()=>({}),Object,COURSE_REMINDER_OPTIONS:[]};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function updateSchoolPreferences('),source.indexOf('function ',source.indexOf('function updateSchoolPreferences(')+10)),context);
 const courseLink={groupKey:'g',courseId:'21',edupageAccount:'edu',managebacAccount:'mb'};
 context.updateSchoolPreferences({courseLink});assert.equal(persisted.settings.schoolPreferences.courseLinks.items.g,'21');
 assert.throws(()=>context.updateSchoolPreferences({courseLink:{...courseLink,managebacAccount:'other'}}));
 const before=JSON.stringify(secureStore.data);secureStore.save=()=>{throw Error('disk')};
 assert.throws(()=>context.updateSchoolPreferences({courseLink}));assert.equal(JSON.stringify(secureStore.data),before);
});
