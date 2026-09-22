import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { encode, hash, readRows, type Store } from '../src/archive.ts';
import { mergeTradeHistory, mergeSnapshotHistory, type HistoryOwner } from '../src/history-merge.ts';
import { researchExport } from '../src/research-export.ts';
import { unifyCollectionHealth } from '../src/build-unified.ts';

// 운영 DB로 실행하지 않는다. CI의 일회성 PostgreSQL 17만 허용한다.
const url = new URL(process.env.HISTORY_MERGE_TEST_URL!);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
assert.equal(url.pathname, '/history_merge_test');
const client = new pg.Client({ connectionString: url.toString(), ssl: false });
await client.connect();
const sources = ['hist_a', 'hist_b', 'hist_c'];
const asOf = '2026-09-22T00:00:00Z';
const cutB = '2026-09-21T15:00:00Z', cutC = '2026-09-21T15:10:00Z';
const owners: HistoryOwner[] = ['soul', 'card'].flatMap(itemId => [
  { itemId, source: 'hist_a', from: null, to: cutB },
  { itemId, source: 'hist_b', from: cutB, to: cutC },
  { itemId, source: 'hist_c', from: cutC, to: null },
]);
const files = new Map<string, Buffer>();
const store: Store = { get: async key => files.get(key) ?? null, put: async (key, value) => { files.set(key, value); } };

// fixture도 실제 보관의 JSON 원문/gzip/해시 검사를 거친다. JS Number로 원본을 바꾸지 않는다.
async function archiveCopy(source: string, table: string, condition: string, offset: number) {
  const rows = (await client.query(`SELECT jsonb_build_array(id-${offset})::text AS key,
    (to_jsonb(t)||jsonb_build_object('id',id-${offset}))::text AS row FROM public.${table} t
    WHERE ${condition} ORDER BY id`)).rows;
  const bytes = encode(rows), shard = { table, day: 'all', hash: hash(bytes), rows: rows.length, bytes: bytes.length };
  await store.put(`objects/${shard.hash}.jsonl.gz`, bytes);
  const restored = await readRows(store, shard);
  await client.query(`INSERT INTO ${source}.${table} SELECT * FROM
    jsonb_populate_recordset(NULL::${source}.${table},$1::jsonb)`, ['[' + restored.map(r => r.row).join(',') + ']']);
}
const candleSql = (table: string) => `SELECT item_id,date_trunc('hour',sold_date) AS hour,
  (array_agg(unit_price ORDER BY sold_date,id))[1] AS o,MAX(unit_price) AS h,MIN(unit_price) AS l,
  (array_agg(unit_price ORDER BY sold_date DESC,id DESC))[1] AS c,
  SUM(unit_price::numeric*count)/SUM(count) AS vwap,SUM(count)::int AS qty,COUNT(*)::int AS n
  FROM ${table} GROUP BY 1,2 ORDER BY 1,2`;
async function transaction(fn: () => Promise<void>) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try { await fn(); } finally { await client.query('ROLLBACK'); }
}
try {
  await client.query(readFileSync('sql/schema.postgres.sql', 'utf8'));
  await client.query('CREATE ROLE anon; CREATE ROLE authenticated');
  await client.query(readFileSync('sql/research.sql', 'utf8'));
  await client.query(`INSERT INTO items(item_id,item_name,category) VALUES
    ('soul','테스트 소울','소울 결정'),('card','테스트 카드','카드');
    INSERT INTO trades(id,item_id,sold_date,unit_price,count,price,dup_seq,ingested_at) VALUES
    (1,'soul','2026-09-21T14:59:59.123456Z',100,2,200,0,'2026-09-21T15:00:01Z'),
    (2,'soul','2026-09-21T14:59:59.123456Z',100,2,200,1,'2026-09-21T15:00:01Z'),
    (3,'soul','2026-09-21T15:00:00Z',110,3,330,0,'2026-09-21T15:00:01Z'),
    (4,'soul','2026-09-21T15:00:00Z',120,1,120,0,'2026-09-21T15:00:01Z'),
    (5,'soul','2026-09-21T15:05:00Z',130,4,520,0,'2026-09-21T15:05:01Z'),
    (6,'soul','2026-09-21T15:10:00Z',140,5,700,0,'2026-09-21T15:10:01Z'),
    (7,'soul','2026-09-21T15:11:00Z',150,6,900,0,'2026-09-21T15:11:01Z'),
    (9007199254740993,'soul','2026-09-21T15:12:00.000001Z',9007199254740993,1,9007199254740993,0,'2026-09-21T15:12:01Z');
    INSERT INTO candles_1h(item_id,hour,o,h,l,c,vwap,qty,n) ${candleSql('public.trades')};
    INSERT INTO listing_snapshots(id,item_id,captured_at,min_unit_price,listing_count,total_qty,upgrade,upgrade_max) VALUES
    (1,'soul','2026-09-21T14:59:59.999999Z',100,2,20,NULL,NULL),
    (2,'card','2026-09-21T14:59:59.999999Z',1000,2,2,0,2),
    (3,'card','2026-09-21T14:59:59.999999Z',2000,2,2,2,2),
    (4,'soul','2026-09-21T15:00:00Z',110,3,30,NULL,NULL),
    (5,'card','2026-09-21T15:00:00Z',NULL,0,0,0,2),
    (6,'card','2026-09-21T15:00:00Z',2200,3,3,2,2),
    (7,'soul','2026-09-21T15:10:00Z',120,4,40,NULL,NULL),
    (8,'card','2026-09-21T15:10:00Z',1300,4,4,0,2),
    (9,'card','2026-09-21T15:10:00Z',2400,4,4,2,2)`);
  for (const source of sources) await client.query(`CREATE SCHEMA ${source};
    CREATE TABLE ${source}.trades (LIKE public.trades INCLUDING ALL);
    CREATE TABLE ${source}.listing_snapshots (LIKE public.listing_snapshots INCLUDING ALL)`);
  await archiveCopy('hist_a', 'trades', 'id<=4', 0);
  await archiveCopy('hist_b', 'trades', 'id BETWEEN 3 AND 6', 2);
  await archiveCopy('hist_c', 'trades', 'id>=6', 5);
  await archiveCopy('hist_a', 'listing_snapshots', 'id<=6', 0);
  await archiveCopy('hist_b', 'listing_snapshots', 'id>=4', 3);
  await archiveCopy('hist_c', 'listing_snapshots', 'id>=7', 6);

  await assert.rejects(() => mergeTradeHistory(client, sources, asOf), /REPEATABLE READ/);
  await transaction(async () => {
    const trade = await mergeTradeHistory(client, sources, asOf);
    assert.deepEqual(trade, { observations: 11, trades: 8, qty: '24', amount: '9007199254743963' });
    assert.equal((await client.query("SELECT COUNT(*)::int n FROM merged_trades WHERE sold_date='2026-09-21T14:59:59.123456Z' AND count=2")).rows[0].n, 2,
      'dup_seq가 다른 실제 복수 체결을 보존');
    assert.equal((await client.query('SELECT MAX(unit_price)::text p FROM merged_trades')).rows[0].p, '9007199254740993');
    assert.deepEqual((await client.query(candleSql('merged_trades'))).rows,
      (await client.query(candleSql('public.trades'))).rows, '전환 시간봉 OHLC/VWAP/수량/건수 일치');
    const snapshots = await mergeSnapshotHistory(client, sources, owners, asOf);
    assert.deepEqual(snapshots, { observations: 15, snapshots: 9 });
    const fields = 'item_id,captured_at,min_unit_price,total_qty,upgrade';
    assert.deepEqual((await client.query(`SELECT ${fields} FROM merged_listing_snapshots ORDER BY item_id,captured_at,upgrade`)).rows,
      (await client.query(`SELECT ${fields} FROM public.listing_snapshots ORDER BY item_id,captured_at,upgrade`)).rows);

    const build = readFileSync('web/build.ts', 'utf8');
    const queries = [...build.matchAll(/const \w+ = \(await history\('([^']+)', '([^']+)', (\[[^\]]+\])\)<[\s\S]*?>\(`([\s\S]*?)`(?:, (\[[^\n]*\]))?\)\).rows;/g)];
    assert.equal(queries.length, 9);
    const expected = [];
    for (const q of queries) expected.push((await client.query(q[4], q[5] ? [asOf] : [])).rows);
    const research = await researchExport(client as any, asOf, asOf);
    await client.query(`CREATE TEMP VIEW trades AS SELECT * FROM merged_trades;
      CREATE TEMP VIEW listing_snapshots AS SELECT * FROM merged_listing_snapshots;
      CREATE TEMP TABLE candles_1h ON COMMIT DROP AS ${candleSql('merged_trades')}`);
    for (const [i,q] of queries.entries()) assert.deepEqual(
      (await client.query(q[4], q[5] ? [asOf] : [])).rows, expected[i], `실제 쿼리 ${q[1]}`);
    assert.deepEqual(await researchExport(client as any, asOf, asOf), research, '연구 출력 일치');
  });
  await transaction(async () => {
    await client.query('UPDATE hist_b.trades SET price=price+1 WHERE id=1');
    await assert.rejects(() => mergeTradeHistory(client, sources, asOf), /내용이 출처별로/);
  });
  await transaction(async () => {
    await assert.rejects(() => mergeSnapshotHistory(client, sources,
      [...owners, { itemId: 'soul', source: 'hist_c', from: cutB, to: null }], asOf), /담당이 겹칩니다/);
  });
  await transaction(async () => {
    await assert.rejects(() => mergeSnapshotHistory(client, sources,
      owners.map(o => o.source==='hist_b' ? { ...o, from: '2026-09-21T15:00:01Z' } : o), asOf), /전환에 공백/);
  });
  await transaction(async () => {
    const trade = await mergeTradeHistory(client, sources, '2026-09-21T15:05:01Z');
    assert.equal(trade.trades, 5, '기준 시각 뒤의 관측을 섞지 않음');
  });
  await transaction(async () => {
    await client.query(`CREATE TEMP TABLE history_owners(item_id text,source_schema text,from_at timestamptz,to_at timestamptz);
      INSERT INTO history_owners VALUES
        ('stay','hist_b','2026-09-21T15:00Z',NULL),
        ('move','hist_b','2026-09-21T15:00Z','2026-09-21T15:10Z'),
        ('move','hist_c','2026-09-21T15:10Z',NULL);
      CREATE TABLE hist_b.collection_health(checked_at timestamptz,gap_min numeric,stale_items int);
      CREATE TABLE hist_c.collection_health(LIKE hist_b.collection_health);
      INSERT INTO hist_b.collection_health VALUES
        ('2026-09-21T15:05Z',1,0),('2026-09-21T15:10Z',2,0),
        ('2026-09-21T15:15Z',1,0),('2026-09-21T15:20Z',NULL,0);
      INSERT INTO hist_c.collection_health VALUES
        ('2026-09-21T15:05Z',99,9),('2026-09-21T15:10Z',3,1),
        ('2026-09-21T15:20Z',1,0),('2026-09-21T15:25Z',1,0)`);
    await unifyCollectionHealth(client,['hist_b','hist_c'],'2026-09-21T15:22Z');
    assert.deepEqual((await client.query('SELECT gap_min,stale_items FROM collection_health ORDER BY checked_at')).rows,
      [{gap_min:'1',stale_items:0},{gap_min:'3',stale_items:1},{gap_min:null,stale_items:null},{gap_min:null,stale_items:0}],
      'C 전 정상 이력 유지, 분할 후 빠진 점검/NULL/미래 기록은 정상으로 간주하지 않음');
  });
  console.log('병합 검증 통과: ID 충돌·중복 체결·동일키 복수 체결·정밀도·전환 시간봉·담당 관측·충돌/공백 중단·이력 쿼리 9개·연구 출력');
} finally { await client.end(); }
