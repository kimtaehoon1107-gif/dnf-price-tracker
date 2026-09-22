// 운영 행을 내려받거나 변경하지 않고, 두 DB 분할 전에 종목별 부담을 비교한다.
// 출력은 배치 초안이다. 수집기의 라우팅 설정으로 자동 적용하지 않는다.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../src/db.ts';

const directory = process.argv[2];
assert(directory && /^archive-work-[a-z0-9-]+$/.test(directory),
  '사용법: node --env-file=.env scripts/plan-db-split.ts archive-work-split-날짜');
const root = resolve(directory);
await mkdir(root); // 이전 조사 결과를 덮어쓰지 않는다.
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");
  const checkedAt = (await client.query('SELECT now() AS t')).rows[0].t.toISOString();
  const items = (await client.query(`SELECT item_id,item_name,category,poll_interval_sec,tracked
    FROM items ORDER BY item_id`)).rows;
  assert(items.length && new Set(items.map(i => i.item_id)).size === items.length);
  const tables = ['trades', 'candles_1h', 'listings', 'listing_deltas', 'listing_snapshots', 'collection_runs'];
  const sizes: Record<string, any[]> = {};
  for (const table of tables) {
    // pg_column_size는 행의 논리 크기다. 인덱스·빈 공간·플랫폼 청구 용량과 구별한다.
    sizes[table] = (await client.query(`SELECT item_id,COUNT(*)::int AS rows,
      SUM(pg_column_size(t))::float8 AS bytes FROM public.${table} t GROUP BY item_id`)).rows;
    assert(sizes[table].every(r => items.some(i => i.item_id === r.item_id)), `${table}: 미등록 아이템`);
  }
  const listing = (await client.query(`SELECT l.item_id,COUNT(*)::int AS rows,
    SUM(octet_length(jsonb_build_array(l.auction_no,l.unit_price,l.cur_count,l.expire_date)::text))::float8 AS bytes
    FROM listings l JOIN items i USING(item_id)
    WHERE l.closed_at IS NULL AND (i.category IS DISTINCT FROM '카드' OR l.upgrade=0 OR l.upgrade=l.upgrade_max)
    GROUP BY l.item_id`)).rows;
  const inventory = (await client.query(`SELECT schemaname,relname,n_live_tup,
    pg_total_relation_size(relid)::float8 AS relation_bytes FROM pg_stat_user_tables
    WHERE schemaname IN ('public','feedback_private') ORDER BY schemaname,relname`)).rows;
  const cron = (await client.query('SELECT jobname,schedule,active FROM cron.job ORDER BY jobname')).rows;
  const ancillary = (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM auth.users) AS auth_users,
    (SELECT COUNT(*)::int FROM storage.buckets) AS storage_buckets,
    (SELECT COUNT(*)::int FROM public.feedback_posts) AS feedback_posts,
    (SELECT COUNT(*)::int FROM feedback_private.admin) AS feedback_admins`)).rows[0];
  await client.query('ROLLBACK');

  const loads = items.map(item => {
    assert(Number.isFinite(item.poll_interval_sec) && item.poll_interval_sec > 0);
    const detail = Object.fromEntries(tables.map(t => [t, sizes[t].find(r => r.item_id === item.item_id) ?? { rows: 0, bytes: 0 }]));
    const logicalBytes = Object.values(detail).reduce((n, r) => n + r.bytes, 0);
    // 현재 매물 수와 폴링 주기가 하루 동안 일정하다고 가정한 비교용 대리지표다.
    const listingProxyDailyBytes = item.tracked
      ? (listing.find(r => r.item_id === item.item_id)?.bytes ?? 0) * 86400 / item.poll_interval_sec : 0;
    return { ...item, logicalBytes, listingProxyDailyBytes, detail };
  });
  const totals = loads.reduce((s, i) => ({ logicalBytes: s.logicalBytes + i.logicalBytes,
    listingProxyDailyBytes: s.listingProxyDailyBytes + i.listingProxyDailyBytes }),
  { logicalBytes: 0, listingProxyDailyBytes: 0 });
  assert(totals.logicalBytes > 0 && totals.listingProxyDailyBytes > 0);
  const pressure = (i: typeof totals) => Math.max(i.logicalBytes / totals.logicalBytes,
    i.listingProxyDailyBytes / totals.listingProxyDailyBytes);
  const shards = ['b', 'c'].map(id => ({ id, items: [] as typeof loads, logicalBytes: 0, listingProxyDailyBytes: 0 }));
  for (const item of [...loads].sort((a, b) => pressure(b) - pressure(a) || a.item_id.localeCompare(b.item_id))) {
    const target = shards[0].items.length === 0 ? shards[0] : shards[1].items.length === 0 ? shards[1]
      : pressure(shards[0]) <= pressure(shards[1]) ? shards[0] : shards[1];
    target.items.push(item); target.logicalBytes += item.logicalBytes;
    target.listingProxyDailyBytes += item.listingProxyDailyBytes;
  }
  assert.equal(new Set(shards.flatMap(s => s.items.map(i => i.item_id))).size, items.length);
  const report = { status: 'proposal-not-applied', checkedAt, totals, shards, inventory, cron, ancillary,
    caveats: ['매물 JSON 대리지표는 실제 PostgreSQL 프로토콜·Supabase 청구 전송량이 아니다.',
      '논리 행 크기는 인덱스·빈 공간을 포함하지 않는다. 신규 DB 크기를 보장하지 않는다.',
      '빌드·보관·전역 테이블 부담은 분배 점수에서 제외됐다. 전환 전 별도 예산이 필요하다.',
      '폴링 주기가 바뀌어도 DB 소유자를 자동 변경하면 안 된다. 확정한 아이템 ID 배치를 사용한다.'] };
  await writeFile(resolve(root, 'plan.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ checkedAt, output: `${directory}/plan.json`, items: items.length,
    shards: shards.map(s => ({ id: s.id, items: s.items.length,
      logicalMB: +(s.logicalBytes / 1e6).toFixed(2), listingProxyMBPerDay: +(s.listingProxyDailyBytes / 1e6).toFixed(2),
      largest: [...s.items].sort((a,b) => b.listingProxyDailyBytes-a.listingProxyDailyBytes).slice(0,4).map(i => i.item_name) })),
    ancillary, productionModified: false }, null, 2));
} finally {
  await client.query('ROLLBACK').catch(() => {}); client.release(); await pool.end();
}
