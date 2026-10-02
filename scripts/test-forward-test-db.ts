import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { H } from '../src/activity-study.ts';
import { SERIES, FT_VERSION } from '../src/forward-test.ts';
import { loadSeries, readForwardTestReport, recordForwardTest } from '../src/forward-test-db.ts';

// 실제 SQL을 격리 스키마에서 실행하고 전체 롤백한다. 운영 행을 변경하지 않는다.
const utc = (s: string) => Date.parse(s);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA ft_test; SET LOCAL search_path = ft_test, public;
    CREATE TABLE items (item_id text PRIMARY KEY, item_name text);
    CREATE TABLE candles_1h (item_id text, hour timestamptz, vwap numeric, qty int, n int);
    CREATE TABLE legendary_card_floor (id bigserial PRIMARY KEY, captured_at timestamptz, p10 bigint, upgrade int);`);
  const schema = readFileSync(new URL('../sql/forward-test.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // 여러 번 적용해도 안전
  assert.equal((await client.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='ft_test' AND tablename LIKE 'forward_test_%'`)).rows[0].n, 2);

  const ids = Object.values(SERIES).flatMap((s) => (s.itemId ? [{ id: s.itemId, name: s.label }] : []));
  await client.query('INSERT INTO items(item_id,item_name) SELECT * FROM unnest($1::text[],$2::text[])', [ids.map((i) => i.id), ids.map((i) => i.name)]);
  // 2026-08-25 ~ 2026-10-12 시간별 자료. 값은 시각의 결정적 함수라 시간을 건너뛰어도 비교할 수 있다.
  const from = utc('2026-08-25T00:00:00Z'), to = utc('2026-10-12T00:00:00Z');
  const price = (t: number) => 1000 * (1 + 0.02 * Math.sin(t / H * 0.9) + 0.01 * Math.sin(t / H / 24 * 6.3));
  const hours = Array.from({ length: (to - from) / H }, (_, i) => from + i * H);
  await client.query(`INSERT INTO candles_1h(item_id,hour,vwap,qty,n)
    SELECT i, to_timestamp(t/1000.0), p, 5, 2 FROM unnest($1::text[]) i CROSS JOIN unnest($2::float8[],$3::float8[]) AS x(t,p)`,
  [ids.map((i) => i.id), hours, hours.map(price)]);
  // 체결이 없거나(qty 0) 가격이 0인 봉, 목록 밖 종목의 봉은 읽지 않는다.
  await client.query(`DELETE FROM candles_1h WHERE item_id=$1 AND hour IN ('2026-09-20 00:00+00','2026-09-20 01:00+00')`, [ids[0].id]);
  await client.query(`INSERT INTO candles_1h(item_id,hour,vwap,qty,n) VALUES
    ($1,'2026-09-20 00:00+00',777,0,0),($1,'2026-09-20 01:00+00',0,3,1),('not-a-soul-crystal','2026-09-20 02:00+00',555,5,1)`, [ids[0].id]);
  // 레전더리 P10: 같은 시간에 기록이 둘이면 마지막을 본다. 마지막이 가격 없음이면 그 시간은 비운다. 0업이 아닌 행은 무시한다.
  await client.query(`INSERT INTO legendary_card_floor(captured_at,p10,upgrade)
    SELECT to_timestamp(t/1000.0)+interval '10 minutes', p::bigint, 0 FROM unnest($1::float8[],$2::float8[]) AS x(t,p)`, [hours, hours.map(price)]);
  await client.query(`INSERT INTO legendary_card_floor(captured_at,p10,upgrade) VALUES
    ('2026-09-21 01:50+00',123456,0),('2026-09-21 01:55+00',NULL,0),   -- 마지막 상태가 가격 없음 → 01시 제외
    ('2026-09-21 02:05+00',111,0),('2026-09-21 02:50+00',222,0),       -- 마지막 값 222 (기존 02:10 행도 있지만 02:50이 더 늦다)
    ('2026-09-21 03:20+00',999999,2),('2026-09-21 04:20+00',888888,NULL)`);

  // 시간별 계열: 집계가 끝난 시간(through 이전)만, 체결 없는 시간·가격 없는 시간 제외.
  const through = utc('2026-10-02T21:00:00Z');
  const series = await loadSeries(client, through);
  const legendary = series.get('soul-legendary')!.points, p10 = series.get('legendary-p10')!.points;
  assert(legendary.every((p) => p.t < through && p.t >= through - 45 * 86400000));
  assert(!legendary.some((p) => p.t === utc('2026-09-20T00:00:00Z')), '체결 수량 0인 시간은 제외');
  assert(!legendary.some((p) => p.t === utc('2026-09-20T01:00:00Z')), 'vwap 0인 시간은 제외');
  // numeric 열을 거치며 15자리로 반올림되므로 허용 오차로 비교한다.
  assert(Math.abs(legendary.find((p) => p.t === utc('2026-09-20T03:00:00Z'))!.price - price(utc('2026-09-20T03:00:00Z'))) < 1e-9);
  assert.equal(new Set(legendary.map((p) => p.t)).size, legendary.length);
  assert(!p10.some((p) => p.t === utc('2026-09-21T01:00:00Z')), '시간 안 마지막 기록이 가격 없음이면 앞선 가격으로 채우지 않는다');
  assert.equal(p10.find((p) => p.t === utc('2026-09-21T02:00:00Z'))!.price, 222, '같은 시간의 마지막 기록');
  assert.equal(p10.find((p) => p.t === utc('2026-09-21T03:00:00Z'))!.price, Math.round(price(utc('2026-09-21T03:00:00Z'))), '0업이 아닌 행은 무시');
  assert(p10.every((p) => p.t < through));

  // 발행 → 중복 → 다음 주 발행과 실측 확정.
  const q = (asOf: string) => ({ checkedAt: asOf, through: asOf.slice(0, 13) + ':00:00Z' });
  const first = await recordForwardTest(client, client, q('2026-10-02T21:06:00Z'), utc('2026-10-02T21:10:00Z'));
  assert.deepEqual([first.issued, first.skipped, first.settled], [3, 0, 0]);
  const rows = (await client.query(`SELECT hypothesis,target,payload,data_as_of FROM forward_test_issues WHERE version=$1 ORDER BY hypothesis`, [FT_VERSION])).rows;
  assert.deepEqual(rows.map((r) => r.hypothesis), ['H1', 'S1', 'S2']);
  assert(rows.every((r) => r.target === '2026-10-02T21:00:00.000Z' && r.payload.status === 'issued' && r.payload.inputHash.length === 64));
  assert.equal((await recordForwardTest(client, client, q('2026-10-02T21:06:00Z'), utc('2026-10-02T21:10:00Z'))).issued, 0);
  const monday = await recordForwardTest(client, client, q('2026-10-04T21:06:00Z'), utc('2026-10-04T21:10:00Z'));
  assert.deepEqual([monday.issued, monday.settled], [10, 3]);
  assert.equal((await client.query(`SELECT count(*)::int n FROM forward_test_issues WHERE target='2026-10-05'`)).rows[0].n, 7);
  const week = await recordForwardTest(client, client, q('2026-10-11T21:06:00Z'), utc('2026-10-11T21:10:00Z'));
  assert(week.settled >= 7, `주간 실측 확정 ${week.settled}`);
  const h2 = (await client.query(`SELECT values FROM forward_test_actuals WHERE hypothesis='H2' AND target='2026-10-05'`)).rows[0].values;
  assert.equal(h2.status, 'ok');
  assert.equal(h2.commonSlots, 24);
  const report = await readForwardTestReport(client, utc('2026-10-12T00:00:00Z'));
  assert.equal(report!.version, FT_VERSION);
  assert.equal(report!.hypotheses.length, 10);
  assert.equal(report!.hypotheses.find((h) => h.id === 'H2')!.status, 'collecting');
  console.log('전향 검증 DB: 스키마 멱등·시간별 계열 SQL·발행 중복 방지·실측 확정·보고서 읽기 통과(전체 롤백)');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
