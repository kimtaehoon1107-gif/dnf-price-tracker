import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { checkCandles } from '../src/candle-check.ts';

// 실제 정본 SQL을 세션 임시 테이블/함수로 바꾼다. 운영 행과 외부 HTTP는 건드리지 않는다.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE trades (
    id bigint, item_id text, sold_date timestamptz, unit_price bigint, count int);
    CREATE TEMP TABLE candles_1h (
    item_id text, hour timestamptz, o bigint,h bigint,l bigint,c bigint,vwap numeric,qty int,n int,
    PRIMARY KEY(item_id,hour));`);
  let candles = readFileSync('sql/schema.postgres.sql', 'utf8')
    .split('-- BEGIN CANDLE PIPELINE')[1].split('-- END CANDLE PIPELINE')[0];
  for (const name of ['trades', 'candles_1h', 'candle_pipeline_state', 'refresh_candles_1h', 'prune_aggregated_trades']) {
    candles = candles.replace(new RegExp(`\\b${name}\\b`, 'g'), `pg_temp.${name}`);
  }
  candles = candles.replaceAll('73190421', '73190422');
  await client.query(candles);
  // 40일 전 원본도 온전히 남은 독립 fixture다.
  await client.query(`UPDATE pg_temp.candle_pipeline_state SET raw_from=date_trunc('hour',now()-interval '40 days');
    INSERT INTO pg_temp.trades VALUES
      (1,'boundary',date_trunc('hour',now()-interval '3 days')+interval '24 seconds',100,1),
      (2,'boundary',date_trunc('hour',now()-interval '3 days')+interval '5 minutes',200,1),
      (3,'backfill',date_trunc('hour',now()-interval '29 days'),300,2),
      (4,'archive',date_trunc('hour',now()-interval '36 days'),400,3);
    SELECT pg_temp.refresh_candles_1h();
    SELECT pg_temp.refresh_candles_1h(date_trunc('hour',now()-interval '3 days')+interval '2 minutes');`);
  const boundary = (await client.query(`SELECT n,vwap::float8 AS vwap FROM pg_temp.candles_1h WHERE item_id='boundary'`)).rows[0];
  assert.deepEqual(boundary, { n: 2, vwap: 150 });
  assert.equal((await client.query(`SELECT n FROM pg_temp.candles_1h WHERE item_id='backfill'`)).rows[0].n, 1);
  await client.query(`INSERT INTO pg_temp.trades VALUES
    (5,'backfill',date_trunc('hour',now()-interval '29 days')+interval '10 minutes',600,1);
    SELECT pg_temp.refresh_candles_1h();`);
  assert.equal((await client.query(`SELECT vwap::float8 AS vwap FROM pg_temp.candles_1h WHERE item_id='backfill'`)).rows[0].vwap, 400);
  assert.equal((await checkCandles(client)).mismatches, 0);
  // 집계 뒤에 들어온 과거 체결은 다음 집계 대기다. 기존 봉의 손상은 여전히 잡아야 한다.
  await client.query(`INSERT INTO pg_temp.trades VALUES
    (10,'backfill',date_trunc('hour',now()-interval '29 days')+interval '20 minutes',900,1),
    (11,'pending-new',date_trunc('hour',now()-interval '2 days'),250,1);`);
  const pending = await checkCandles(client);
  assert.equal(pending.mismatches, 0);
  assert.equal(pending.pendingTrades, 2);
  assert.equal(pending.pendingBars, 2);
  await client.query(`UPDATE pg_temp.candles_1h SET n=1 WHERE item_id='backfill'`);
  assert.equal((await checkCandles(client)).mismatches, 1);
  await client.query('SELECT pg_temp.refresh_candles_1h()');
  assert.equal((await checkCandles(client)).mismatches, 0);
  assert.equal((await checkCandles(client)).pendingTrades, 0);
  assert.equal((await client.query(`SELECT n FROM pg_temp.candles_1h WHERE item_id='backfill'`)).rows[0].n, 3);
  // 기존 불완전한 경계는 보호하고, 새 종목의 그 이전 백필은 따로 집계한다.
  await client.query(`INSERT INTO pg_temp.candles_1h
    (item_id,hour,o,h,l,c,vwap,qty,n) VALUES
    ('legacy',date_trunc('hour',now()-interval '41 days'),100,100,100,100,100,10,10);
    INSERT INTO pg_temp.trades VALUES
    (8,'legacy',date_trunc('hour',now()-interval '41 days'),100,1),
    (9,'new-old',date_trunc('hour',now()-interval '41 days'),200,1);
    SELECT pg_temp.refresh_candles_1h();`);
  assert.equal((await client.query(`SELECT n FROM pg_temp.candles_1h WHERE item_id='legacy'`)).rows[0].n, 10);
  assert.equal((await client.query(`SELECT n FROM pg_temp.candles_1h WHERE item_id='new-old'`)).rows[0].n, 1);
  // 검사는 망가진 값을 고치지 않아야 한다.
  await client.query(`UPDATE pg_temp.candles_1h SET n=1 WHERE item_id='boundary'`);
  assert.equal((await checkCandles(client)).mismatches, 1);
  assert.equal((await client.query(`SELECT n FROM pg_temp.candles_1h WHERE item_id='boundary'`)).rows[0].n, 1);
  await client.query(`SELECT pg_temp.prune_aggregated_trades()`);
  assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM pg_temp.trades WHERE item_id='archive'`)).rows[0].n, 0);
  assert.equal((await client.query(`SELECT n FROM pg_temp.candles_1h WHERE item_id='archive'`)).rows[0].n, 1);
  assert.equal((await checkCandles(client)).mismatches, 0);
  // 삭제 경계의 시간봉은 통째로 남긴다.
  await client.query(`INSERT INTO pg_temp.trades VALUES
    (6,'edge',date_trunc('hour',now()-interval '35 days')+interval '1 second',500,1);
    SELECT pg_temp.prune_aggregated_trades();`);
  assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM pg_temp.trades WHERE item_id='edge'`)).rows[0].n, 1);
  // 집계가 실패하면 원본 삭제도 롤백된다.
  await client.query('SAVEPOINT failed_refresh');
  await client.query(`INSERT INTO pg_temp.trades VALUES (7,'invalid',now()-interval '3 days',100,0)`);
  await assert.rejects(client.query('SELECT pg_temp.prune_aggregated_trades()'));
  await client.query('ROLLBACK TO SAVEPOINT failed_refresh');
  assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM pg_temp.trades WHERE item_id='backfill'`)).rows[0].n, 3);

  await client.query(`CREATE TEMP TABLE items(item_id text,tracked bool,poll_interval_sec int);
    CREATE TEMP TABLE collection_runs(item_id text,finished_at timestamptz,error text);
    CREATE TEMP TABLE collection_health(checked_at timestamptz DEFAULT now(),last_collect_at timestamptz,
      gap_min numeric,stale_items int,action text,note text,recovery_request_id bigint,alert_request_id bigint);
    CREATE TEMP TABLE audit_http(url text);
    CREATE FUNCTION pg_temp.audit_http_post(url text,body jsonb,headers jsonb) RETURNS bigint
      LANGUAGE plpgsql AS $a$ BEGIN INSERT INTO pg_temp.audit_http VALUES(url); RETURN 1; END; $a$;`);
  let watchdog = readFileSync('sql/watchdog.sql', 'utf8').split('AS $fn$')[1].split('$fn$;')[0];
  for (const name of ['items', 'collection_runs', 'collection_health']) {
    watchdog = watchdog.replace(new RegExp(`\\b${name}\\b`, 'g'), `pg_temp.${name}`);
  }
  watchdog = watchdog.replaceAll('net.http_post', 'pg_temp.audit_http_post')
    .replace(/SELECT decrypted_secret INTO v_token\s+FROM vault\.decrypted_secrets WHERE name = 'gh_dispatch_token';/, "v_token := 'fixture';");
  assert(!watchdog.includes('vault.') && !watchdog.includes('net.http_post'));
  await client.query('CREATE FUNCTION pg_temp.audit_watchdog() RETURNS void LANGUAGE plpgsql AS $a$' + watchdog + '$a$');
  await client.query(`INSERT INTO pg_temp.items VALUES('healthy',true,120),('stale',true,300);
    INSERT INTO pg_temp.collection_runs VALUES('healthy',now(),NULL),('stale',now()-interval '2 hours',NULL);
    SELECT pg_temp.audit_watchdog();`);
  assert.equal((await client.query('SELECT recovery_request_id FROM pg_temp.collection_health')).rows[0].recovery_request_id, 1);
  // 즉시 재점검해도 복구 요청을 반복하지 않는다.
  await client.query('SELECT pg_temp.audit_watchdog()');
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_temp.audit_http')).rows[0].n, 1);
  await client.query(`TRUNCATE pg_temp.collection_health,pg_temp.audit_http;
    UPDATE pg_temp.collection_runs SET finished_at=now()-interval '1 hour';
    INSERT INTO pg_temp.collection_health(checked_at,action,recovery_request_id) VALUES
      (now()-interval '20 minutes','recover',1),(now()-interval '10 minutes','recover',2);
    SELECT pg_temp.audit_watchdog();
    UPDATE pg_temp.collection_health SET checked_at=checked_at-interval '5 minutes';
    SELECT pg_temp.audit_watchdog();`);
  const requests = (await client.query(`SELECT
    COUNT(*) FILTER (WHERE url LIKE '%dispatches')::int AS recover,
    COUNT(*) FILTER (WHERE url LIKE '%issues')::int AS alert FROM pg_temp.audit_http`)).rows[0];
  assert.deepEqual(requests, { recover: 1, alert: 1 });
  await client.query(`UPDATE pg_temp.collection_runs SET finished_at=now();SELECT pg_temp.audit_watchdog()`);
  assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM pg_temp.collection_health WHERE action='ok'`)).rows[0].n, 1);
  await client.query('TRUNCATE pg_temp.audit_http');
  let candleWatch = readFileSync('sql/candle-watchdog.sql', 'utf8').split('SELECT cron.unschedule')[0];
  for (const name of ['candle_health', 'candle_pipeline_state', 'check_candle_health']) {
    candleWatch = candleWatch.replace(new RegExp(`\\b${name}\\b`, 'g'), `pg_temp.${name}`);
  }
  candleWatch = candleWatch.replaceAll('net.http_post', 'pg_temp.audit_http_post')
    .replace(/SELECT decrypted_secret INTO v_token\s+FROM vault\.decrypted_secrets WHERE name='gh_dispatch_token';/, "v_token := 'fixture';");
  assert(!candleWatch.includes('vault.') && !candleWatch.includes('net.http_post'));
  await client.query(candleWatch);
  await client.query(`UPDATE pg_temp.candle_pipeline_state SET refreshed_at=now()-interval '90 minutes';
    SELECT pg_temp.check_candle_health();`);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_temp.audit_http')).rows[0].n, 0);
  await client.query(`UPDATE pg_temp.candle_pipeline_state SET refreshed_at=now()-interval '90 minutes 1 second';
    SELECT pg_temp.check_candle_health();SELECT pg_temp.check_candle_health();`);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_temp.audit_http')).rows[0].n, 1);
  const staleQuality = await checkCandles(client);
  assert.equal(staleQuality.mismatches, 0);
  assert.equal(staleQuality.stale, true, '과거 정합성이 통과해도 집계 지연을 감지해야 한다.');
  await client.query(`UPDATE pg_temp.candle_health SET checked_at=checked_at-interval '6 hours';
    UPDATE pg_temp.candle_pipeline_state SET refreshed_at=NULL;
    SELECT pg_temp.check_candle_health();`);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_temp.audit_http')).rows[0].n, 2);
  await client.query(`UPDATE pg_temp.candle_pipeline_state SET refreshed_at=now();SELECT pg_temp.check_candle_health()`);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_temp.candle_health WHERE NOT stale')).rows[0].n, 2);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_temp.audit_http')).rows[0].n, 2);
  // 빌드의 실제 1시간 가격 쿼리를 검증한다. 수량이 다른 거래·시간 경계·카드 제외를 분리한다.
  const priceSQL = readFileSync('web/build.ts', 'utf8').split('  recent_trade AS (')[1].split('\n  ),')[0]
    .replace(/\b(trades|items)\b/g, 'pg_temp.$1');
  await client.query(`ALTER TABLE pg_temp.items ADD COLUMN category text;
    INSERT INTO pg_temp.items(item_id,category) VALUES
      ('weighted','소울 결정'),('single','소울 결정'),('old-only','소울 결정'),('empty','소울 결정'),('card-price','카드');
    INSERT INTO pg_temp.trades VALUES
      (100,'weighted',now()-interval '10 minutes',100,1),
      (101,'weighted',now()-interval '5 minutes',100,1),
      (102,'weighted',now(),130,10),
      (103,'weighted',now()-interval '1 hour',9999,100),
      (104,'weighted',now()+interval '1 second',9999,100),
      (105,'single',now()-interval '1 minute',200,3),
      (106,'old-only',now()-interval '2 hours',300,1),
      (107,'card-price',now()-interval '1 minute',400,1);`);
  const prices = (await client.query(`WITH recent_trade AS (${priceSQL}) SELECT * FROM recent_trade ORDER BY item_id`)).rows;
  assert.deepEqual(prices, [
    { item_id: 'single', vwap1h: 200, trades1h: 1, api_qty1h: 3 },
    { item_id: 'weighted', vwap1h: 125, trades1h: 3, api_qty1h: 12 },
  ]);
  console.log('집계·보존·감시·1시간 VWAP 수량 가중/경계/무거래/카드 제외 테스트 통과 (운영 변경 없음)');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
