import assert from 'node:assert/strict';
import pg from 'pg';
import { buildPriceDistribution } from '../src/build-price-distribution.ts';
const url=new URL(process.env.HISTORY_MERGE_TEST_URL!);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55432');assert.equal(url.pathname,'/history_merge_test');
const client=new pg.Client({connectionString:url.toString(),ssl:false});
await client.connect();
try {
  await client.query(`BEGIN;
    CREATE TABLE public.items(item_id text,category text,tracked boolean);
    CREATE TABLE public.trades(id bigint,item_id text,sold_date timestamptz,unit_price bigint,count int);
    CREATE TABLE public.candle_pipeline_state(singleton boolean,raw_max_id bigint);
    CREATE TABLE public.candles_1h(item_id text,hour timestamptz,n int,qty int,l bigint,h bigint,vwap numeric);
    INSERT INTO items VALUES('dense','재료',true),('card','카드',true);
    INSERT INTO candle_pipeline_state VALUES(true,5);
    INSERT INTO trades VALUES
      (1,'dense','2026-09-20T15:01Z',100,80),
      (2,'dense','2026-09-20T15:02Z',200,10),
      (3,'dense','2026-09-20T15:02Z',200,10),
      (4,'dense','2026-09-20T16:01Z',900,1),
      (5,'card','2026-09-20T16:01Z',100,1),
      (6,'dense','2026-09-20T16:02Z',9999,99);
    INSERT INTO candles_1h VALUES
      ('dense','2026-09-20T15:00Z',3,100,100,200,120),
      ('dense','2026-09-20T16:00Z',1,1,900,900,900),
      ('dense','2026-09-19T15:00Z',20,30,100,300,150),
      ('card','2026-09-20T16:00Z',1,1,100,100,100)`);
  await buildPriceDistribution(client);
  const rows=(await client.query("SELECT *,bucket AT TIME ZONE 'Asia/Seoul' AS kst FROM price_distributions ORDER BY kind,bucket")).rows;
  const days=rows.filter(r=>r.kind==='day');
  assert.equal(days.length,2);
  assert.equal(days[0].median,null,'원본 없는 오래된 봉의 평균으로 분위수를 만들지 않음');
  assert.equal(days[1].n,4,'동일 가격·수량인 별도 체결과 집계 ID 경계 보존');
  assert.equal(days[1].qty,101);
  assert.deepEqual([days[1].q25,days[1].median,days[1].q75],[100,100,100],'건수가 아닌 수량 가중 분위수');
  assert.equal(days[1].h,900,'극단값 원본 보존');
  assert(rows.every(r=>r.item_id!=='card'));
  await client.query('DROP TABLE price_distributions; DELETE FROM trades WHERE id=2');
  await buildPriceDistribution(client);
  const incomplete=(await client.query("SELECT median FROM price_distributions WHERE kind='day' ORDER BY bucket DESC LIMIT 1")).rows[0];
  assert.equal(incomplete.median,null,'일부 원본만 있으면 일별 분포를 표시하지 않음');
  console.log('가격 분포 SQL: 수량 분위수·KST 경계·중복 체결·부분 원본·집계 경계·극단값 보존 통과');
} finally {await client.query('ROLLBACK');await client.end();}
