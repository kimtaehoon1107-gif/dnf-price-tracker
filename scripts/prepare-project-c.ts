// B의 C 담당 종목만 초기화한다. B는 읽기 전용이며 C 예약은 모두 꺼 둔다.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import pg from 'pg';
import { hash, quote } from '../src/archive.ts';

const apply=process.argv.includes('--apply');
assert(process.argv.slice(2).every(a=>a==='--apply'));
assert.equal(new URL(process.env.DATABASE_URL_B!).username,'postgres.ejtjwtlehkzuutqgzevu');
assert.equal(new URL(process.env.DATABASE_URL_C!).username,'postgres.eixqezzwmzxrmtnfhomj');
const plan=JSON.parse(readFileSync('archive-work-split-20260922/plan.json','utf8'));
const ids: string[]=plan.shards.find((s:any)=>s.id==='c').items.map((i:any)=>i.item_id);
assert.equal(ids.length,16);assert.equal(new Set(ids).size,16);
const ssl={ca:readFileSync('certs/supabase-prod-ca-2021.crt','utf8'),rejectUnauthorized:true};
const b=new pg.Client({connectionString:process.env.DATABASE_URL_B,ssl});
const c=new pg.Client({connectionString:process.env.DATABASE_URL_C,ssl});
const selections: Record<string,string>={items:'SELECT * FROM items',
  ...Object.fromEntries(['trades','candles_1h','listings','listing_deltas','listing_snapshots','collection_runs']
    .map(t=>[t,`SELECT * FROM ${t} WHERE item_id=ANY($1)`])),
  candle_pipeline_state:'SELECT * FROM candle_pipeline_state'};
let phase='connect';
try {
  await b.connect();await c.connect();
  await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await b.query("SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='60s'");
  await c.query('BEGIN');await c.query("SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  assert.equal((await c.query("SELECT 1 FROM pg_tables WHERE schemaname='public' LIMIT 1")).rowCount,0,'빈 C에만 실행합니다');
  const budget=[];
  for(const [table,sql] of Object.entries(selections)) budget.push({table,...(await b.query(
    `SELECT count(*)::int rows,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::int bytes FROM (${sql}) t`,sql.includes('$1')?[ids]:[])).rows[0]});
  const bytes=budget.reduce((n,t)=>n+t.bytes,0);assert(bytes<20_000_000,'C 초기 복사 20MB 예산 초과');
  console.log(JSON.stringify({mode:apply?'apply':'inspect',items:ids.length,bytes,tables:budget}));
  if(apply) {
    for(const file of ['schema.postgres.sql','research.sql','legendary-scans.sql']) {phase=file;await c.query(readFileSync(`sql/${file}`,'utf8'));}
    for(const [table,sql] of Object.entries(selections)) {
      phase=`copy ${table}`;
      const columns=(await b.query(`SELECT * FROM (${sql}) t LIMIT 0`,sql.includes('$1')?[ids]:[])).fields.map(f=>f.name);
      const rows=(await b.query(`SELECT to_jsonb(t)::text row FROM (${sql}) t`,sql.includes('$1')?[ids]:[])).rows.map(r=>r.row);
      if(table==='candle_pipeline_state') await c.query('DELETE FROM candle_pipeline_state');
      const actual:string[]=[];
      for(let i=0;i<rows.length;i+=500) {
        const result=await c.query(`INSERT INTO ${quote(table)}(${columns.map(quote).join(',')})
          SELECT ${columns.map(quote).join(',')} FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb)
          RETURNING to_jsonb(${quote(table)}.*)::text row`,['['+rows.slice(i,i+500).join(',')+']']);
        actual.push(...result.rows.map(r=>r.row));
      }
      assert.equal(hash(actual.sort().join('\n')),hash(rows.sort().join('\n')),`${table} 복사 대조 실패`);
      if(columns.includes('id')) await c.query(`SELECT setval(pg_get_serial_sequence($1,'id'),
        coalesce((SELECT max(id) FROM ${quote(table)}),1),(SELECT count(*)>0 FROM ${quote(table)}))`,[table]);
    }
    await c.query('UPDATE items SET tracked=(item_id=ANY($1))',[ids]);
    phase='services';await c.query('CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net');
    assert.equal((await c.query('SELECT 1 FROM cron.job LIMIT 1')).rowCount,0);
    const token=(await b.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='gh_dispatch_token'")).rows;
    assert.equal(token.length,1);
    await c.query("SELECT vault.create_secret($1,'gh_dispatch_token','기존 수집 예약의 C 담당 연결')",[token[0].decrypted_secret]);
    for(const file of ['scheduler.sql','watchdog.sql','candle-watchdog.sql']) {
      await c.query(readFileSync(`sql/${file}`,'utf8').replaceAll('{"ref":"main"}','{"ref":"main","inputs":{"database":"C"}}'));
    }
    await c.query('SELECT cron.alter_job(jobid,active:=false) FROM cron.job');
    // 전역 사이트와 이벤트는 B만 실행한다. C에 잘못 켤 수 있는 중복 예약을 남기지 않는다.
    await c.query("SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('dnf-pages-dispatch','dnf-events-dispatch')");
    for(const row of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)
      await c.query(`ALTER TABLE ${quote(row.tablename)} ENABLE ROW LEVEL SECURITY`);
    await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,authenticated;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon,authenticated;
      REVOKE EXECUTE ON FUNCTION refresh_candles_1h(timestamptz),prune_aggregated_trades(),check_collection_health(),check_candle_health() FROM PUBLIC,anon,authenticated`);
    await c.query('SELECT refresh_candles_1h()');
    const jobs=(await c.query('SELECT jobname,schedule,active FROM cron.job ORDER BY jobname')).rows;
    assert.equal(jobs.length,8);assert(jobs.every(j=>!j.active));
    await c.query('COMMIT');
    mkdirSync('archive-work-cutover-20260922-c',{recursive:true});
    const result={preparedAt:new Date().toISOString(),ids,bytes,tables:budget,jobs};
    writeFileSync('archive-work-cutover-20260922-c/prepared.json',JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({prepared:true,items:ids.length,bytes,jobs}));
  }
} catch(e) {console.error(e instanceof assert.AssertionError?e.message:`C 준비 실패: ${phase} (${(e as any).code??'query'})`);process.exitCode=1;}
finally {await b.query('ROLLBACK').catch(()=>{});await c.query('ROLLBACK').catch(()=>{});await b.end();await c.end();}
