import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL attendance rules and access boundary',async t=>{
 const db=new PGlite();
 try{
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(await readFile(new URL('../supabase/migrations/202610130001_attendance.sql',import.meta.url),'utf8'));
  const rpc=async(op,hash,payload={})=>(await db.query('select public.attendance_rpc($1,$2,$3::jsonb) result',[op,hash,JSON.stringify(payload)])).rows[0].result;
  const h1='a'.repeat(64),h2='b'.repeat(64),h3='c'.repeat(64);
  const sub1='U'+'1'.repeat(32),sub2='U'+'2'.repeat(32),sub3='U'+'3'.repeat(32);
  let owner,brother,worker,location;
  await t.test('verified login enrolls an ordinary account and only matching bootstrap becomes admin',async()=>{
   owner=(await rpc('login',null,{lineSub:sub1,name:'哥',sessionHash:h1,bootstrapSub:sub1})).me;
   brother=(await rpc('login',null,{lineSub:sub2,name:'弟',sessionHash:h2,bootstrapSub:sub1})).me;
   worker=(await rpc('login',null,{lineSub:sub3,name:'同事',sessionHash:h3,bootstrapSub:sub3})).me;
   assert.equal(owner.role,'admin');assert.equal(brother.role,'employee');assert.equal(worker.role,'employee');
  });
  await t.test('anon cannot read tables or invoke trusted RPC',async()=>{
   await db.exec('set role anon');
   await assert.rejects(db.query('select * from public.attendance_punches'),/permission denied/);
   await assert.rejects(rpc('snapshot',h1),/permission denied/);
   await db.exec('reset role');
  });
  await t.test('invalid sessions and unauthorized admin operations are rejected',async()=>{
   await assert.rejects(rpc('snapshot','f'.repeat(64)),/UNAUTHENTICATED/);
   await assert.rejects(rpc('location',h3,{name:'A',lat:25,lng:121,radiusMeters:2000,enabled:true}),/FORBIDDEN/);
  });
  await t.test('last enabled admin cannot be demoted',async()=>{
   await assert.rejects(rpc('employee',h1,{id:owner.id,name:'哥',role:'employee',enabled:true}),/LAST_ADMIN/);
  });
  await rpc('employee',h1,{id:brother.id,name:'弟',role:'admin',enabled:true});
  await t.test('admin creates a real 2 km work location',async()=>{
   location=(await rpc('location',h1,{name:'A 工作點',lat:25.033,lng:121.5654,radiusMeters:2000,enabled:true})).id;
   assert.equal((await rpc('snapshot',h1)).locations[0].radiusMeters,2000);
  });
  const body=(type,key,position={})=>({type,key,fingerprint:key.padEnd(64,'0'),position:{lat:25.033,lng:121.5654,accuracy:20,capturedAt:new Date().toISOString(),...position}});
  await t.test('outside, poor accuracy and stale coordinates do not create punches',async()=>{
   await assert.rejects(rpc('punch',h3,body('in','outside',{lat:26})),/OUTSIDE_GEOFENCE/);
   await assert.rejects(rpc('punch',h3,body('in','uncertain',{accuracy:200})),/POSITION_UNCERTAIN/);
   await assert.rejects(rpc('punch',h3,body('in','boundary',{lat:25.033+1995/6371008.8*180/Math.PI})),/POSITION_UNCERTAIN/);
   await assert.rejects(rpc('punch',h3,body('in','stale',{capturedAt:new Date(Date.now()-600000).toISOString()})),/POSITION_STALE/);
   assert.equal((await rpc('snapshot',h3)).records.length,0);
  });
  let original;
  await t.test('database records server time and returns an idempotent result',async()=>{
   const request=body('in','first');original=await rpc('punch',h3,request);
   assert.ok(Math.abs(Date.parse(original.timestamp)-Date.now())<5000);
   assert.equal((await rpc('punch',h3,request)).id,original.id);
   await assert.rejects(rpc('punch',h3,{...request,fingerprint:'different'}),/IDEMPOTENCY_CONFLICT/);
   assert.equal((await rpc('snapshot',h3)).records.length,1);
  });
  await t.test('duplicate clock-in and clock-out-before-in are rejected',async()=>{
   await assert.rejects(rpc('punch',h3,body('in','second')),/PUNCH_STATE_CONFLICT/);
   await assert.rejects(rpc('punch',h2,body('out','early-out')),/PUNCH_STATE_CONFLICT/);
   await rpc('punch',h3,body('out','clock-out'));
  });
  await t.test('ordinary employee snapshot contains only their own records and no audit',async()=>{
   const snap=await rpc('snapshot',h2);assert.equal(snap.me.role,'admin');
   const own=await rpc('snapshot',h3);assert.equal(own.employees.length,1);assert.equal(own.audit.length,0);assert.ok(own.records.every(r=>r.employeeId===worker.id));
  });
  let req;
  await t.test('own correction requires another admin even for rejection',async()=>{
   req=await rpc('correction',h1,{type:'in',timestamp:new Date(Date.now()-3600000).toISOString(),reason:'忘記上班打卡'});
   await assert.rejects(rpc('review',h1,{id:req.id,decision:'approved',note:'已確認出勤'}),/SELF_REVIEW_FORBIDDEN/);
   await assert.rejects(rpc('review',h1,{id:req.id,decision:'rejected',note:'資料不完整'}),/SELF_REVIEW_FORBIDDEN/);
  });
  await t.test('another admin approves once, appending attendance and audit together',async()=>{
   await rpc('review',h2,{id:req.id,decision:'approved',note:'已確認出勤'});
   await assert.rejects(rpc('review',h2,{id:req.id,decision:'approved',note:'再次確認出勤'}),/ALREADY_REVIEWED/);
   const snap=await rpc('snapshot',h1);assert.equal(snap.records.filter(r=>r.requestId===req.id).length,1);assert.ok(snap.audit.some(e=>e.detail.requestId===req.id&&e.action==='審核補打卡'));
  });
  await t.test('historical correction with conflicting sequence rolls back approval',async()=>{
   const conflict=await rpc('correction',h1,{type:'in',timestamp:new Date(Date.now()-1800000).toISOString(),reason:'時間需要更正'});
   await assert.rejects(rpc('review',h2,{id:conflict.id,decision:'approved',note:'檢查出勤時間'}),/SEQUENCE_CONFLICT/);
   const snap=await rpc('snapshot',h1);assert.equal(snap.requests.find(r=>r.id===conflict.id).status,'pending');assert.equal(snap.records.filter(r=>r.requestId===conflict.id).length,0);
   await rpc('review',h2,{id:conflict.id,decision:'rejected',note:'與已有紀錄衝突'});
  });
  await t.test('location configuration is versioned and saved punch snapshot stays unchanged',async()=>{
   await rpc('location',h1,{id:location,name:'A 新名稱',lat:25.033,lng:121.5654,radiusMeters:2000,enabled:false});
   const snap=await rpc('snapshot',h1);assert.equal(snap.locations[0].version,2);assert.equal(snap.records.find(r=>r.id===original.id).locationName,'A 工作點');
   await assert.rejects(rpc('punch',h3,body('in','after-disabled')),/NO_LOCATIONS/);
  });
  await t.test('history is retained and queried with Taiwan calendar boundaries',async()=>{
   await db.query("insert into public.attendance_punches(employee_id,type,occurred_at,source) values ($1,'in','2020-01-01T16:30:00Z','correction'),($1,'out','2020-01-01T17:30:00Z','correction')",[worker.id]);
   assert.equal((await rpc('snapshot',h3,{from:'2020-01-01',to:'2020-01-01'})).records.length,0);
   const old=await rpc('snapshot',h3,{from:'2020-01-02',to:'2020-01-02'});assert.equal(old.records.length,2);assert.ok(old.records.every(r=>r.employeeId===worker.id));
  });
  await t.test('export is authorized for caller scope and records an audit event',async()=>{
   const data=await rpc('export',h3,{from:'2020-01-02',to:'2020-01-02'});assert.equal(data.employees.length,1);assert.ok(data.records.every(r=>r.employeeId===worker.id));
   assert.equal((await db.query("select detail->>'scope' scope from public.attendance_audit where action='匯出出勤' order by id desc limit 1")).rows[0].scope,'self');
  });
  await t.test('only backend service role can execute the protected RPC',async()=>{
   await db.exec('set role service_role');assert.equal((await rpc('snapshot',h1)).me.id,owner.id);await db.exec('reset role');
  });
  await t.test('disabled employees lose all sessions',async()=>{
   await rpc('employee',h1,{id:worker.id,name:'同事',role:'employee',enabled:false});
   await assert.rejects(rpc('snapshot',h3),/UNAUTHENTICATED/);
   await assert.rejects(rpc('login',null,{lineSub:sub3,name:'同事',sessionHash:'d'.repeat(64)}),/ACCOUNT_DISABLED/);
  });
  await t.test('logout revokes only its own session',async()=>{
   await rpc('logout',h2);await assert.rejects(rpc('snapshot',h2),/UNAUTHENTICATED/);assert.equal((await rpc('snapshot',h1)).me.id,owner.id);
  });
  await t.test('expired sessions cannot read records',async()=>{
   const h4='d'.repeat(64);await rpc('login',null,{lineSub:sub1,name:'哥',sessionHash:h4});await db.query("update public.attendance_sessions set expires_at=now()-interval '1 second' where hash=$1",[h4]);await assert.rejects(rpc('snapshot',h4),/UNAUTHENTICATED/);
  });
 }finally{await db.close();}
});
