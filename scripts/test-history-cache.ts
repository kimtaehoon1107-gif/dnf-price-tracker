import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { HistoryCache } from '../src/history-cache.ts';
import type { Store } from '../src/archive.ts';
import { researchExport } from '../src/research-export.ts';
import { PACKAGE_ID } from '../src/research-data.ts';

// 외부 DB에 연결하지 않는다. CI의 일회성 PostgreSQL 17에서 실행한다.
const url = new URL(process.env.HISTORY_TEST_URL!);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
assert.equal(url.pathname, '/history_test');
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
const pool = new pg.Pool({ connectionString: url.toString(), ssl: false });
const client = await pool.connect();
const files = new Map<string, Buffer>();
const store: Store = {
  async get(key) { return files.get(key) ?? null; },
  async put(key, bytes) { files.set(key, bytes); },
};
const cache = new HistoryCache(client, store);
const options = { label: 'fixture', day: 'd', order: ['item_id', 'd', 'id'] };
const sql = `SELECT item_id, to_char(at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') d,
  id, price, amount, optional, active, tags, at, details
  FROM history_fixture WHERE at < $1::timestamptz ORDER BY item_id,d,id`;
const params = ['2026-09-22T00:00:00Z'];
async function compare(query = sql, args = params) {
  const expected = (await client.query(query, args)).rows;
  const actual = (await cache.query(options)(query, args)).rows;
  assert.deepEqual(actual, expected, '일반 조회와 R2 재사용 결과·자료형·순서 일치');
  return actual;
}
try {
  await client.query(readFileSync('sql/schema.postgres.sql', 'utf8'));
  await client.query('CREATE ROLE anon; CREATE ROLE authenticated');
  await client.query(readFileSync('sql/research.sql', 'utf8'));
  await client.query(`INSERT INTO items (item_id,item_name,category) VALUES
    ('a','테스트 결정','소울 결정'),('b','테스트 카드','카드'),($1,'테스트 패키지','패키지')`, [PACKAGE_ID]);
  await client.query(`INSERT INTO candles_1h (item_id,hour,o,h,l,c,vwap,qty,n)
    SELECT item_id,date_trunc('hour',now())-h*interval '1 hour',100,120,90,110,105.25,20,5
    FROM items CROSS JOIN generate_series(1,72) h WHERE category<>'카드';
    INSERT INTO trades (item_id,sold_date,unit_price,count,price)
    SELECT item_id,hour,100,20,2000 FROM candles_1h;
    INSERT INTO listing_snapshots (item_id,captured_at,min_unit_price,listing_count,total_qty,upgrade,upgrade_max)
    SELECT i.item_id,c.hour+interval '20 minutes',CASE WHEN c.n=5 THEN 110 ELSE NULL END,5,100,
      CASE WHEN i.category='카드' THEN u ELSE NULL END,CASE WHEN i.category='카드' THEN 2 ELSE NULL END
    FROM items i CROSS JOIN (SELECT * FROM candles_1h WHERE item_id='a') c CROSS JOIN (VALUES(0),(2)) tiers(u)
    WHERE i.category='카드' OR u=0;
    INSERT INTO legendary_card_floor (captured_at,min_unit_price,min_item_id,min_item_name,p10,median,scanned,with_listings,total_listings,upgrade)
    SELECT hour,100,'b','테스트 카드',110,120,165,100,200,0 FROM candles_1h WHERE item_id='a'`);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const asOf = (await client.query('SELECT now() at')).rows[0].at.toISOString();
  // 실제 사이트 쿼리 9개를 그대로 대조한다. 테스트용으로 SQL을 따로 복사하지 않는다.
  const build = readFileSync('web/build.ts', 'utf8');
  const queries = [...build.matchAll(/const \w+ = \(await history\('([^']+)', '([^']+)', (\[[^\]]+\])\)<[\s\S]*?>\(`([\s\S]*?)`(?:, (\[[^\n]*\]))?\)\).rows;/g)];
  assert.equal(queries.length, 9);
  for (const [, label, day, order, text, args] of queries) {
    const parameters = args ? [asOf] : [];
    const query = cache.query({ label, day, order: JSON.parse(order.replaceAll("'", '"')) });
    const expected = (await client.query(text, parameters)).rows;
    assert(expected.length > 0, `${label}: 빈 결과만 검사하지 않음`);
    assert.deepEqual((await query(text, parameters)).rows, expected, label);
    const bytes = cache.stats.fetchedBytes;
    assert.deepEqual((await query(text, parameters)).rows, expected, label);
    assert.equal(cache.stats.fetchedBytes, bytes, `${label}: 두 번째 본문 전송 없음`);
  }
  const expectedResearch = await researchExport(client, asOf, asOf);
  assert.deepEqual(await researchExport(client, asOf, asOf, cache), expectedResearch);
  const warmBytes = cache.stats.fetchedBytes;
  assert.deepEqual(await researchExport(client, asOf, asOf, cache), expectedResearch);
  assert.equal(cache.stats.fetchedBytes, warmBytes);
  console.log('사이트 이력 쿼리 9개 및 연구 출력 전체: 일반 조회와 최초·재사용 결과 일치');
  await client.query('ROLLBACK');
  cache.stats = { queries: 0, reusedDays: 0, fetchedDays: 0, reusedBytes: 0, fetchedBytes: 0 };
  files.clear();
  await client.query(`CREATE TEMP TABLE history_fixture (
    item_id text, id bigint, at timestamptz, price float8, amount numeric,
    optional text, active boolean, tags text[], details jsonb
  ); INSERT INTO history_fixture VALUES
    ('b',1,'2026-08-20T14:00:00Z',100.125,12345678901234567890.123456,NULL,true,ARRAY['한글','comma,value'],'{"x":null}'),
    ('a',2,'2026-08-20T15:00:00Z',200.5,0,'',false,ARRAY[]::text[],'{"x":2}'),
    ('a',3,'2026-09-20T14:00:00Z',300,1,'수정 전',true,NULL,NULL),
    ('a',4,'2026-09-20T14:00:00Z',400,2,NULL,true,NULL,NULL)`);
  await assert.rejects(() => cache.query(options)(sql, params), /동일 DB 스냅샷/);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await compare();
  assert.equal(cache.stats.fetchedDays, 3, '최초 조회만 전체 날짜 전송');
  const firstBytes = cache.stats.fetchedBytes;
  await compare();
  assert.equal(cache.stats.fetchedBytes, firstBytes, '변경 없는 재실행은 데이터 본문 전송 0');
  assert.equal(cache.stats.reusedDays, 3);
  await client.query('ROLLBACK');

  await client.query(`UPDATE history_fixture SET price=999,optional='정정' WHERE id=1;
    INSERT INTO history_fixture VALUES ('a',5,'2026-09-21T01:00:00Z',500,3,NULL,true,NULL,NULL)`);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const oldFetched = cache.stats.fetchedDays;
  const corrected = await compare();
  assert.equal(corrected.find(r => r.id === 1)!.price, 999, '오래된 날짜의 정정 반영');
  assert.equal(cache.stats.fetchedDays - oldFetched, 2, '정정 날짜와 새 날짜만 다운로드');
  await client.query('ROLLBACK');

  await client.query('DELETE FROM history_fixture WHERE id IN (1,3)');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const deleted = await compare();
  assert(!deleted.some(r => r.id === 1 || r.id === 3), '행 및 날짜 전체 삭제를 캐시가 되살리지 않음');
  await compare(sql, ['2026-09-01T00:00:00Z']);
  const beforeEmpty = cache.stats.fetchedBytes;
  assert.deepEqual(await compare(sql, ['2020-01-01T00:00:00Z']), []);
  assert.equal(cache.stats.fetchedBytes, beforeEmpty, '빈 조회는 다운로드 없음');
  await compare(sql.replace('price, amount', 'price * 2 AS price, amount'));
  assert(files.size > 3, '쿼리 정의가 바뀌면 캐시 구분');

  const unavailable = new HistoryCache(client, {
    async get() { throw new Error('R2 unavailable'); }, async put() { assert.fail('write'); },
  });
  await assert.rejects(() => unavailable.query(options)(sql, params), /R2 unavailable/);
  assert.equal(unavailable.stats.fetchedBytes, 0, 'R2 장애 시 전체 다운로드로 우회하지 않음');
  assert.deepEqual((await new HistoryCache(client).query(options)(sql, params)).rows,
    (await client.query(sql, params)).rows, 'R2 미설정 로컬 작업의 기존 조회 유지');
  for (const key of files.keys()) files.set(key, Buffer.from('broken gzip'));
  await assert.rejects(() => cache.query(options)(sql, params), /header|compression|gzip/i);
  console.log('이력 재사용 검증 통과: 원본 동등성·타입·KST 경계·과거 정정·신규·삭제·범위 변경·장애');
} finally {
  await client.query('ROLLBACK'); client.release(); await pool.end();
}
