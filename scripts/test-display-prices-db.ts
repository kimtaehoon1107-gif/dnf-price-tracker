import assert from 'node:assert/strict';
import pg from 'pg';
import { buildDisplayPrices } from '../src/build-display-prices.ts';
const url = new URL(process.env.DISPLAY_TEST_URL!);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
assert.equal(url.pathname, '/archive_verify');
const client = new pg.Client({ connectionString: url.toString(), ssl: false });
await client.connect();
try {
  await client.query(`BEGIN;
    CREATE TABLE public.items(item_id text,category text,tracked boolean);
    CREATE TABLE public.trades(id bigint,item_id text,sold_date timestamptz,unit_price bigint,count int);
    CREATE TABLE public.candle_pipeline_state(singleton boolean,raw_max_id bigint);
    CREATE TABLE public.candles_1h(item_id text,hour timestamptz,n int,qty int,l bigint,h bigint,vwap numeric);
    INSERT INTO items VALUES('soul','소울 결정',true),('card','카드',true),('partial','재료',true);
    INSERT INTO candle_pipeline_state VALUES(true,100);
    INSERT INTO trades SELECT n,'soul','2026-10-06T04:00Z'::timestamptz+n*interval '1 second',1000,1 FROM generate_series(1,20) n;
    INSERT INTO trades VALUES
      (21,'soul','2026-10-06T04:01Z',100,1),
      (22,'soul','2026-10-06T04:02Z',10000,1),
      (23,'soul','2026-10-06T04:03Z',99,1),
      (24,'soul','2026-10-06T04:04Z',10001,1),
      (25,'soul','2026-10-06T04:05Z',5000000,44),
      (26,'soul','2026-10-06T15:00Z',5000000,1),
      (27,'card','2026-10-06T04:00Z',5000000,1),
      (28,'partial','2026-10-06T04:00Z',100,1);
    INSERT INTO candles_1h SELECT item_id,date_trunc('hour',sold_date),count(*)::int,sum(count)::int,
      min(unit_price),max(unit_price),sum(unit_price::numeric*count)/sum(count)
      FROM trades GROUP BY 1,2;
    UPDATE candles_1h SET n=2,qty=2 WHERE item_id='partial';
    INSERT INTO candles_1h VALUES('soul','2026-09-01T00:00Z',5,5,100,100,100);
    INSERT INTO trades VALUES(101,'soul','2026-10-06T05:00Z',1000,1);`);
  await buildDisplayPrices(client);
  const rows=(await client.query('SELECT * FROM display.trades ORDER BY id')).rows;
  assert(!rows.some(r=>[23,24,25,28].includes(Number(r.id))));
  for(const id of [21,22,26,27,101]) assert(rows.some(r=>Number(r.id)===id));
  const day=(await client.query("SELECT * FROM display.cleaning_days WHERE item_id='soul' AND day='2026-10-06'")).rows[0];
  assert.equal(day.median,1000); assert.equal(day.excluded_n,3); assert.equal(Number(day.excluded_qty),46);
  const candle=(await client.query("SELECT * FROM display.candles_1h WHERE item_id='soul' AND hour='2026-10-06T04:00Z'")).rows[0];
  assert.equal(candle.n,22);assert.equal(candle.qty,22);assert.equal(Number(candle.h),10000);
  assert(Math.abs(Number(candle.vwap)-30100/22)<1e-8);
  assert.equal((await client.query('SELECT count(*)::int n FROM public.trades')).rows[0].n,29);
  assert.equal((await client.query("SELECT count(*)::int n FROM display.candles_1h WHERE hour='2026-10-06T05:00Z'")).rows[0].n,0);
  const dist=(await client.query("SELECT * FROM display.price_distributions WHERE item_id='soul' AND kind='day' ORDER BY bucket")).rows;
  assert.equal(dist.length,2);assert.equal(Number(dist[0].median),1000);
  console.log('PASS: 10x boundaries, KST day isolation, original preservation, pending-ID boundary, incomplete-day exclusion, VWAP/distribution consistency');
} finally { await client.query('ROLLBACK'); await client.end(); }
