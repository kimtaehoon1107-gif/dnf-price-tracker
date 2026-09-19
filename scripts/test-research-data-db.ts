import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { loadResearch } from '../src/research-data.ts';
import { LEGACY_RESEARCH_VERSION } from '../src/research.ts';

// 실제 집계 SQL을 세션 임시 테이블에 실행한다. 운영 행을 변경하지 않는다.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE items (item_id text,category text,tracked boolean DEFAULT true);
    CREATE TEMP TABLE candles_1h (item_id text,hour timestamptz,vwap numeric,qty int,n int);
    CREATE TEMP TABLE listing_snapshots (id bigserial,item_id text,upgrade int,upgrade_max int,captured_at timestamptz,min_unit_price bigint);
    CREATE TEMP TABLE legendary_card_floor (id bigint,captured_at timestamptz,min_unit_price bigint,min_item_name text,
      p10 bigint,median bigint,scanned int,with_listings int,total_listings int,upgrade int);
    INSERT INTO items (item_id,category) SELECT unnest(ARRAY['gone','back','tie','zero','empty','stages']),'카드';
    INSERT INTO listing_snapshots (item_id,upgrade,upgrade_max,captured_at,min_unit_price)
      SELECT i.item_id,0,2,'2026-09-19 00:00+09'::timestamptz+h*interval '1 hour',100
      FROM items i CROSS JOIN generate_series(0,17) h WHERE item_id<>'empty';
    INSERT INTO listing_snapshots (item_id,upgrade,upgrade_max,captured_at,min_unit_price) VALUES
      ('gone',0,2,'2026-09-19 17:55+09',NULL),
      ('back',0,2,'2026-09-19 17:30+09',NULL),('back',0,2,'2026-09-19 17:55+09',100),
      ('tie',0,2,'2026-09-19 17:00+09',NULL),
      ('zero',0,2,'2026-09-19 17:55+09',0),
      ('empty',0,2,'2026-09-19 17:00+09',NULL),
      ('gone',0,2,'2026-09-20 00:00+09',999999);
    INSERT INTO listing_snapshots (item_id,upgrade,upgrade_max,captured_at,min_unit_price)
      SELECT 'stages',2,2,'2026-09-19 00:00+09'::timestamptz+h*interval '1 hour',400 FROM generate_series(0,17) h;`);
  const at = '2026-09-20T02:00:00+09:00';
  const current = await loadResearch(client, at, at);
  const legacy = await loadResearch(client, at, at, LEGACY_RESEARCH_VERSION);
  const price = (data: typeof current, id: string, basis = 'ask0') => data.byBasis.get(basis)?.get(id)?.[0]?.value;
  for (const id of ['gone','tie','zero']) {
    assert.equal(price(current, id), null, `${id}: 마지막 무매물 시간은 18시간 자격에 포함하지 않음`);
    assert.equal(price(legacy, id), 100, '기존 발행의 평가 정의는 보존');
  }
  assert.equal(price(current, 'back'), 100, '같은 시간에 재등장하면 마지막 가격을 사용');
  assert.equal(price(current, 'empty'), null, '온종일 무매물이면 NULL');
  assert.equal(price(current, 'stages'), 100);
  assert.equal(price(current, 'stages', 'askMax'), 400, '0업·맥스업 분리');
  assert.equal(current.byBasis.get('ask0')?.get('gone')?.length, 1, '당일 미완성 관측 제외');
  const weeklySql = readFileSync('web/build.ts', 'utf8').match(/const cardWeekdayDays[^`]*`([^`]+)`/)![1];
  const weekly = (await client.query(weeklySql, [at])).rows;
  assert.equal(weekly.find((r) => r.item_id === 'gone' && r.d === '2026-09-19').hours, 17,
    '메인 weekly 트렌드도 마지막 무매물 시간을 자격에서 제외');
  assert.equal(weekly.find((r) => r.item_id === 'back').hours, 18);

  const schema = readFileSync('sql/legendary-scans.sql', 'utf8').replaceAll('legendary_card_scans', 'pg_temp.legendary_card_scans');
  await client.query(schema);
  await client.query(schema);
  await client.query(`INSERT INTO pg_temp.legendary_card_scans (started_at,status,expected,observations)
    VALUES (now(),'running',1,'[{"itemId":"fixture","status":"pending"}]');
    UPDATE pg_temp.legendary_card_scans SET status='failed',failed=1,finished_at=now(),
      observations='[{"itemId":"fixture","status":"failed","errorCode":"http_503"}]';`);
  const state = (await client.query(`SELECT status,failed,observations FROM pg_temp.legendary_card_scans`)).rows[0];
  assert.equal(state.failed, 1);
  assert.equal(state.observations[0].errorCode, 'http_503');
  const permissions = (await client.query(`SELECT relrowsecurity,relpersistence,
    has_table_privilege('anon',oid,'SELECT') anon_read,
    has_table_privilege('authenticated',oid,'SELECT') authenticated_read
    FROM pg_class WHERE oid='pg_temp.legendary_card_scans'::regclass`)).rows[0];
  assert.deepEqual(permissions, { relrowsecurity: true, relpersistence: 't', anon_read: false, authenticated_read: false });
  console.log('카드 마지막 상태·18시간 자격·기존 집계 보존·레전더리 기록 스키마 DB 테스트 통과');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
