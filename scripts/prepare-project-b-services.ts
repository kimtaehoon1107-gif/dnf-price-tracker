// 예약·피드백 기반을 B에 준비하되 예약은 모두 비활성으로 커밋한다. A에는 SELECT만 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
const ssl={ca:readFileSync('certs/supabase-prod-ca-2021.crt','utf8'),rejectUnauthorized:true};
assert.equal(new URL(process.env.DATABASE_URL!).username,'postgres.ypmnadqnmadrburkrcka');
assert.equal(new URL(process.env.DATABASE_URL_B!).username,'postgres.ejtjwtlehkzuutqgzevu');
const a=new pg.Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000});
const b=new pg.Client({connectionString:process.env.DATABASE_URL_B,ssl,connectionTimeoutMillis:15000});
let phase='connect';
try {
  await a.connect();await b.connect();
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await b.query('BEGIN');
  await b.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  assert.equal((await b.query('SELECT 1 FROM collection_runs LIMIT 1')).rowCount,0,'수집을 시작한 B에는 준비 도구를 재실행하지 않습니다');
  phase='extensions'; await b.query('CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net');
  assert.equal((await b.query('SELECT 1 FROM cron.job LIMIT 1')).rowCount,0,'기존 B 예약을 덮어쓰지 않습니다');
  const token=(await a.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='gh_dispatch_token'")).rows;
  assert.equal(token.length,1,'A의 기존 dispatch 연결을 확인하세요');
  assert.equal((await b.query("SELECT 1 FROM vault.secrets WHERE name='gh_dispatch_token'")).rowCount,0);
  phase='vault'; await b.query("SELECT vault.create_secret($1,'gh_dispatch_token','기존 수집 예약 연결 이전')",[token[0].decrypted_secret]);
  for(const file of ['scheduler.sql','watchdog.sql','candle-watchdog.sql']) {phase=file;await b.query(readFileSync(`sql/${file}`,'utf8'));}
  phase='disable-jobs'; await b.query('SELECT cron.alter_job(jobid,active:=false) FROM cron.job');
  for(const table of ['collection_health','candle_health']) await b.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON ${table} FROM anon,authenticated`);
  await b.query('REVOKE EXECUTE ON FUNCTION check_collection_health(),check_candle_health() FROM PUBLIC,anon,authenticated');
  assert.equal((await b.query("SELECT to_regclass('public.feedback_posts') AS t")).rows[0].t,null);
  const feedback=readFileSync('sql/feedback.sql','utf8').replace(/^BEGIN;\r?$/m,'').replace(/^COMMIT;\r?$/m,'');
  phase='feedback-schema';await b.query(feedback);
  const copied: Record<string,number>={};
  for(const table of ['public.feedback_posts','feedback_private.post_passwords','feedback_private.admin','feedback_private.rate_limits']) {
    const rows=(await a.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t`)).rows;
    assert(rows.reduce((n,r)=>n+Buffer.byteLength(r.row),0)<1_000_000,'피드백 이전 예산 초과');
    if(rows.length) await b.query(`INSERT INTO ${table} ${table==='public.feedback_posts'?'OVERRIDING SYSTEM VALUE':''}
      SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,['['+rows.map(r=>r.row).join(',')+']']);
    assert.equal((await b.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,rows.length);copied[table]=rows.length;
  }
  await b.query(`SELECT setval(pg_get_serial_sequence('public.feedback_posts','id'),
    coalesce((SELECT max(id) FROM feedback_posts),1),(SELECT count(*)>0 FROM feedback_posts))`);
  const jobs=(await b.query('SELECT jobname,schedule,active FROM cron.job ORDER BY jobname')).rows;
  assert.equal(jobs.length,10);assert(jobs.every(j=>!j.active));
  await b.query('COMMIT');console.log(JSON.stringify({jobs,feedbackRows:copied,existingAUnchanged:true}));
} catch(e) {
  console.error(e instanceof assert.AssertionError?e.message:`B 서비스 준비 실패: ${phase} (${(e as {code?:string}).code??'connection/query'})`);process.exitCode=1;
} finally {
  await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});await a.end();await b.end();
}
