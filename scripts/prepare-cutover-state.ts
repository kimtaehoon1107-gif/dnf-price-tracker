// 전환 직전 한 번 실행하는 작은 상태 동기화. 새 B에서 수집이 시작된 뒤에는 실행을 거부한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { hash, quote } from '../src/archive.ts';

const args=process.argv.slice(2);
assert(args.length===0 || (args.length===1 && args[0]==='--apply'));
const sourceUrl=new URL(process.env.DATABASE_URL!), targetUrl=new URL(process.env.DATABASE_URL_B!);
assert.equal(sourceUrl.username,'postgres.ypmnadqnmadrburkrcka');
assert.equal(targetUrl.username,'postgres.ejtjwtlehkzuutqgzevu');
const ssl={ca:readFileSync('certs/supabase-prod-ca-2021.crt','utf8'),rejectUnauthorized:true};
const source=new pg.Client({connectionString:sourceUrl.toString(),ssl,connectionTimeoutMillis:15000});
const target=new pg.Client({connectionString:targetUrl.toString(),ssl,connectionTimeoutMillis:15000});
const selections: Record<string,string>={
  items:'SELECT * FROM items',
  listings:`SELECT * FROM listings WHERE closed_at IS NULL
    OR auction_no IN (SELECT DISTINCT ON(item_id) auction_no FROM listings WHERE upgrade_max IS NOT NULL
      ORDER BY item_id,upgrade_max DESC,last_seen_at DESC)`,
  listing_deltas:`SELECT d.* FROM listing_deltas d JOIN listings l USING(auction_no)
    WHERE d.reason='vanished_before_expiry' AND d.invalidated_at IS NULL AND l.expire_date>now()`,
  collection_runs:`SELECT DISTINCT ON(item_id) * FROM collection_runs
    WHERE error IS NULL AND finished_at IS NOT NULL ORDER BY item_id,started_at DESC,id DESC`,
  events:'SELECT * FROM events',
  research_forecast_batches:'SELECT * FROM research_forecast_batches',
  research_actuals:'SELECT * FROM research_actuals',
  market_rankings:'SELECT * FROM market_rankings WHERE captured_at=(SELECT max(captured_at) FROM market_rankings)',
  legendary_card_floor:'SELECT * FROM legendary_card_floor WHERE captured_at=(SELECT max(captured_at) FROM legendary_card_floor)',
  legendary_card_scans:'SELECT * FROM legendary_card_scans ORDER BY started_at DESC LIMIT 1',
};
try {
  await source.connect(); await target.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await source.query("SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='30s'");
  await target.query('BEGIN');
  await target.query("SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await target.query('SELECT pg_advisory_xact_lock(731905,20260922)');
  // items만 있는 초기 준비 상태여야 한다. 실행 중인 B를 과거 상태로 덮어쓰지 않는다.
  for(const table of [...Object.keys(selections).filter(t=>t!=='items'),'trades','listing_snapshots','candles_1h']) {
    assert.equal((await target.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rowCount,0,`B의 ${table}이 비어 있지 않습니다`);
  }
  const plan=[];
  for(const [table,sql] of Object.entries(selections)) {
    const row=(await source.query(`SELECT count(*)::int AS rows,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::int AS bytes FROM (${sql}) t`)).rows[0];
    plan.push({table,...row});
  }
  const total=plan.reduce((n,t)=>n+t.bytes,0);
  assert(total<10_000_000,`초기 상태가 10MB 예산을 넘습니다: ${total}`);
  console.log(JSON.stringify({mode:args.length?'apply':'inspect',tables:plan,totalBytes:total}));
  if(args.length) {
    for(const [table,sql] of Object.entries(selections)) {
      const columns=(await source.query(`SELECT * FROM (${sql}) t LIMIT 0`)).fields.map(f=>f.name);
      const rows=(await source.query(`SELECT to_jsonb(t)::text AS row FROM (${sql}) t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
      if(table==='items') await target.query('DELETE FROM items');
      const actual: string[]=[];
      for(let i=0;i<rows.length;i+=500) {
        const result=await target.query(`INSERT INTO ${quote(table)}(${columns.map(quote).join(',')})
          SELECT ${columns.map(quote).join(',')} FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb)
          RETURNING to_jsonb(${quote(table)}.*)::text AS row`,['['+rows.slice(i,i+500).map(r=>r.row).join(',')+']']);
        actual.push(...result.rows.map(r=>r.row));
      }
      assert.equal(hash(actual.sort().join('\n')),hash(rows.map(r=>r.row).sort().join('\n')),`${table} 대조 불일치`);
      if(columns.includes('id')) await target.query(`SELECT setval(pg_get_serial_sequence($1,'id'),
        coalesce((SELECT max(id) FROM ${quote(table)}),1),(SELECT count(*)>0 FROM ${quote(table)}))`,[table]);
    }
    await target.query('COMMIT');
    console.log('작은 초기 상태 복사 완료. 수집 시작·운영 연결 교체·집계 경계 복사는 하지 않았습니다.');
  }
} catch(e) {
  console.error(e instanceof assert.AssertionError ? e.message : `초기 상태 준비 실패 (${(e as {code?:string}).code??'connection/query'})`);
  process.exitCode=1;
} finally {
  await source.query('ROLLBACK').catch(()=>{}); await target.query('ROLLBACK').catch(()=>{});
  await source.end(); await target.end();
}
