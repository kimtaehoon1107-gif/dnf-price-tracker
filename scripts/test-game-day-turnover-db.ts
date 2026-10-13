import assert from 'node:assert/strict';
import pg from 'pg';
import { gameDayTurnover } from '../src/build-game-day-turnover.ts';
const url = new URL(process.env.DISPLAY_TEST_URL!);
assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55432'); assert.equal(url.pathname,'/archive_verify');
const client = new pg.Client({connectionString:url.toString(),ssl:false});
await client.connect();
try {
  await client.query(`BEGIN;
    CREATE TABLE public.items(item_id text,category text,tracked boolean);
    CREATE TABLE public.candles_1h(item_id text,hour timestamptz,vwap numeric,qty int,n int);
    INSERT INTO items VALUES('soul','소울 결정',true),('card','카드',true),('off','재료',false),('empty','재료',true);
    INSERT INTO candles_1h VALUES
    ('soul','2026-10-11T20:00Z',100,2,1),
    ('soul','2026-10-11T21:00Z',200,3,2),
    ('soul','2026-10-12T20:00Z',300,4,3),
    ('soul','2026-10-12T21:00Z',99999,1,1),
    ('card','2026-10-11T21:00Z',99999,1,1),
    ('off','2026-10-11T21:00Z',99999,1,1);`);
  const result=await gameDayTurnover(client as any,'2026-10-13T12:00:00+09:00');
  assert.equal(result.trackedItems,2);
  assert.equal(result.days.length,30);
  assert.equal(result.days.at(-2)!.amount,200);
  assert.deepEqual(result.days.at(-1),{day:'2026-10-12',amount:1800,trades:5,observedItems:1,observedHours:2});
  assert.equal(result.days[0].amount,null,'No observations must not become a measured zero');
  console.log('Game-day SQL: quantity weighting, boundary exclusion, scope and missing days passed');
} finally {await client.query('ROLLBACK');await client.end();}
