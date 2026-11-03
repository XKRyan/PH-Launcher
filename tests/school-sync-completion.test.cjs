const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('EduPage and ManageBac sync finish without an out-of-scope input variable',async()=>{
 const main=fs.readFileSync(require.resolve('../electron/main.cjs'),'utf8');const start=main.indexOf('async function syncSchool(source');const code=main.slice(start,main.indexOf('\n}',start)+2);
 const context={schoolState:{key(){},sync:async(_s,_o,read)=>read()},schoolAuthenticator:{withSession:async(_s,fn)=>fn()},assertSchoolSessionReady(){},schoolClient:{syncManageBac:async()=>({}),syncEduPage:async()=>({})},managebacReminderAccount:()=>'',siteStoragePersistence:{schedule(){}},session:{fromPartition:()=>({})},SITES:{edupage:{},managebac:{}},publishSchoolSnapshot(){},applySharedLessonSelection(){},scheduleReminderTick(){},schoolSnapshot:()=>({ok:true}),console};
 vm.runInNewContext(code,context);for(const source of ['edupage','managebac'])assert.equal((await context.syncSchool(source,{})).ok,true);
});
