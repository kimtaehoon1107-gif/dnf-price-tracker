import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
const connection=await pool.connect();
const client={query:(sql:string,params?:any[])=>connection.query(sql.replaceAll('feedback_',`feedback_qa_${process.pid}_`),params)};
const password='Feedback-Test-Owner-2026', adminPassword='Feedback-Test-Admin-2026';
const draft={nickname:'QA',category:'bug',title:'테스트 글',body:'<img src=x onerror=alert(1)>',password};
const rpc=async(action:string,data:any)=>(await client.query('SELECT public.feedback_request($1,$2) AS result',[action,data])).rows[0].result;
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
  await client.query(readFileSync('sql/feedback.sql','utf8').replace(/^BEGIN;|^COMMIT;/gm,''));
  await client.query("INSERT INTO feedback_private.admin VALUES(true,extensions.crypt($1,extensions.gen_salt('bf',10))) ON CONFLICT(singleton) DO UPDATE SET password_hash=excluded.password_hash",[adminPassword]);
  for(const role of ['anon','authenticated']) {
    const permissions=(await client.query(`SELECT has_table_privilege($1,'public.feedback_posts','SELECT') AS read,
      has_table_privilege($1,'public.feedback_posts','INSERT') AS write,
      has_function_privilege($1,'public.feedback_request(text,jsonb)','EXECUTE') AS rpc,
      has_schema_privilege($1,'feedback_private','USAGE') AS secrets`,[role])).rows[0];
    assert.deepEqual(permissions,{read:false,write:false,rpc:false,secrets:false});
  }
  await client.query('SET LOCAL ROLE service_role');
  let post=(await rpc('create',draft)).post;
  assert(post.id);
  assert(!JSON.stringify(post).includes('password'));
  assert.equal((await rpc('edit',{...draft,id:post.id,version:post.updated_at,password:'wrong-password'})).status,401);
  assert.equal((await rpc('moderate',{id:post.id,version:post.updated_at,adminPassword:'wrong-admin-password',reply:'위조',status:'done'})).status,401);
  assert.equal((await rpc('detail',{id:post.id,admin:true,adminPassword:'wrong-admin-password'})).status,401);
  const oldVersion=post.updated_at;
  post=(await rpc('edit',{...draft,id:post.id,version:post.updated_at,title:'수정된 제목'})).post;
  assert.equal(post.title,'수정된 제목');
  assert.equal((await rpc('delete',{id:post.id,version:oldVersion,password})).status,409,'오래된 화면으로 삭제하면 충돌 안내');
  post=(await rpc('moderate',{id:post.id,version:post.updated_at,adminPassword,reply:'수정했습니다.',status:'done',hidden:true})).post;
  assert.equal((await rpc('detail',{id:post.id})).status,404);
  assert(!(await rpc('list',{})).posts.some((p:any)=>p.id===post.id));
  assert((await rpc('list',{admin:true,adminPassword})).posts.some((p:any)=>p.id===post.id));
  assert.equal((await rpc('edit',{...draft,id:post.id,version:post.updated_at})).status,404,'작성자도 숨긴 글을 다시 공개하지 못함');
  post=(await rpc('moderate',{id:post.id,version:post.updated_at,adminPassword,reply:'수정했습니다.',status:'done',hidden:false})).post;
  assert.equal((await rpc('detail',{id:post.id})).post.reply,'수정했습니다.');
  const limit=async()=>(await client.query('SELECT public.feedback_rate_limit($1) AS ok',[JSON.stringify([{key:'qa-limit',seconds:60,limit:2}])])).rows[0].ok;
  assert.equal(await limit(),true); assert.equal(await limit(),true); assert.equal(await limit(),false);
  const ids:number[]=[];
  for(let i=0;i<23;i++) ids.push((await rpc('create',{...draft,title:`페이지 ${i}`})).post.id);
  const first=(await rpc('list',{})).posts;
  const second=(await rpc('list',{before:first[19].id})).posts;
  assert.equal(first.length,21); assert(second.every((p:any)=>p.id<first[19].id));
  assert.equal(new Set([...first.slice(0,20),...second].map(p=>p.id)).size,24);
  assert.equal((await rpc('delete',{id:post.id,version:post.updated_at,password})).ok,true);
  assert.equal((await rpc('detail',{id:post.id})).status,404);
  await client.query('RESET ROLE');
  assert.equal((await client.query('SELECT count(*) AS n FROM feedback_private.post_passwords WHERE post_id=$1',[post.id])).rows[0].n,0);
  console.log('게시판 DB CRUD·관리자 권한·숨김·비밀번호·페이지·충돌·직접 API 차단 테스트 통과 (전체 롤백)');
} finally { await client.query('ROLLBACK'); connection.release(); await pool.end(); }
