const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../electron/main.cjs'),'utf8');
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
