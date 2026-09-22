// 임시 DB 전용. 운영 출처의 원본 ID/집계 경계를 분석 DB의 새 ID와 섞지 않는다.
import assert from 'node:assert/strict';
import type { Client } from 'pg';
import { quote } from './archive.ts';
import { mergeTradeHistory, mergeSnapshotHistory, type HistoryOwner } from './history-merge.ts';

export async function installBuildClock(client: Client) {
  await client.query(`CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS
    $$ SELECT current_setting('dnf.as_of')::timestamptz $$`);
}

/** 호출자가 모든 입력을 복원한 뒤 repeatable read 안에서 담당 기간을 전달한다. */
export async function unifyMarket(client: Client, sources: string[], owners: HistoryOwner[], asOf: string,
  globals: { source: string; from: string | null; to: string | null }[]) {
  assert(sources.length && sources.length === new Set(sources).size);
  sources.forEach(quote);
  assert(globals.length && globals.every(g => sources.includes(g.source)));
  // 과거 시작부터 현재까지 연속된 담당 기간을 명시해야 한다.
  for (const id of new Set(owners.map(o => o.itemId))) {
    const epochs = owners.filter(o => o.itemId===id).sort((a,b) => (a.from??'').localeCompare(b.from??''));
    assert.equal(epochs[0].from,null); assert.equal(epochs.at(-1)!.to,null);
  }
  assert.equal(globals[0].from,null); assert.equal(globals.at(-1)!.to,null);
  for(let i=1;i<globals.length;i++) {
    assert.equal(globals[i-1].to,globals[i].from);
    assert(globals[i].from && (!globals[i].to || Date.parse(globals[i].from!)<Date.parse(globals[i].to!)));
  }
  const trades = await mergeTradeHistory(client,sources,asOf);
  const snapshots = await mergeSnapshotHistory(client,sources,owners,asOf);
  const current = (table: string) => sources.map(s => `SELECT t.* FROM ${quote(s)}.${quote(table)} t
    JOIN history_owners o ON o.item_id=t.item_id AND o.source_schema='${s}' AND o.to_at IS NULL`).join(' UNION ALL ');
  await client.query(`CREATE TABLE public.items AS ${current('items')}; ALTER TABLE public.items ADD PRIMARY KEY(item_id)`);
  assert.equal((await client.query('SELECT count(*)::int n FROM public.items')).rows[0].n,new Set(owners.map(o=>o.itemId)).size);
  await client.query(`CREATE TEMP TABLE build_source_states ON COMMIT DROP AS ${sources.map(s =>
    `SELECT '${s}'::text AS source_schema,raw_from,raw_max_id,refreshed_at FROM ${quote(s)}.candle_pipeline_state WHERE singleton`).join(' UNION ALL ')}`);
  const invalid = (await client.query(`SELECT 1 FROM build_source_states WHERE raw_max_id IS NULL OR refreshed_at IS NULL LIMIT 1`)).rowCount;
  assert.equal(invalid,0,'집계 성공 경계가 없는 출처입니다');
  const activeSources = [...new Set(owners.filter(o=>o.to===null).map(o=>o.source))];
  const state = (await client.query(`SELECT min(refreshed_at) AS refreshed_at FROM build_source_states WHERE source_schema=ANY($1)`,[activeSources])).rows[0];
  // 가장 오래된 출처의 완전한 원본 경계 전은 이미 원본이 정리된 시간봉일 수 있다.
  const rawFrom = (await client.query(`SELECT raw_from FROM build_source_states WHERE source_schema=$1`,[sources[0]])).rows[0].raw_from;
  await client.query(`CREATE TEMP TABLE build_trade_keys ON COMMIT DROP AS
    SELECT item_id,sold_date,unit_price,count,reinforce,dup_seq,bool_or(i.source_id<=s.raw_max_id) AS eligible
    FROM history_trade_input i JOIN build_source_states s USING(source_schema) GROUP BY 1,2,3,4,5,6;
    CREATE TEMP TABLE build_trade_eligible ON COMMIT DROP AS
    SELECT m.*,k.eligible FROM merged_trades m JOIN build_trade_keys k USING(item_id,sold_date,unit_price,count,reinforce,dup_seq)`);
  await client.query(`CREATE TABLE public.trades AS SELECT row_number() OVER (ORDER BY eligible DESC,id)::bigint AS id,
    item_id,sold_date,unit_price,count,price,reinforce,refine,amplification_name,dup_seq,ingested_at FROM build_trade_eligible;
    CREATE UNIQUE INDEX ON public.trades(id); CREATE INDEX ON public.trades(item_id,sold_date)`);
  const maxId = (await client.query('SELECT count(*)::text n FROM build_trade_eligible WHERE eligible')).rows[0].n;
  await client.query(`CREATE TABLE public.candles_1h AS SELECT * FROM ${quote(sources[0])}.candles_1h WHERE hour<$1`,[rawFrom]);
  await client.query(`INSERT INTO public.candles_1h (item_id,hour,o,h,l,c,vwap,qty,n,raw_complete)
    SELECT item_id,date_trunc('hour',sold_date),(array_agg(unit_price ORDER BY sold_date,id))[1],max(unit_price),min(unit_price),
      (array_agg(unit_price ORDER BY sold_date DESC,id DESC))[1],sum(unit_price::numeric*count)/sum(count),sum(count)::int,count(*)::int,true
    FROM public.trades WHERE sold_date>=$1 AND id<=$2 GROUP BY 1,2`,[rawFrom,maxId]);
  await client.query(`CREATE UNIQUE INDEX ON public.candles_1h(item_id,hour);
    CREATE TABLE public.candle_pipeline_state(singleton boolean,raw_from timestamptz,raw_max_id bigint,refreshed_at timestamptz)`);
  await client.query('INSERT INTO public.candle_pipeline_state VALUES(true,$1,$2,$3)',[rawFrom,maxId,state.refreshed_at]);
  await client.query(`CREATE TABLE public.listing_snapshots AS SELECT id,item_id,captured_at,min_unit_price,p10,p25,median,
    listing_count,total_qty,upgrade,upgrade_max FROM merged_listing_snapshots;
    CREATE INDEX ON public.listing_snapshots(item_id,captured_at);
    CREATE TABLE public.listings AS ${current('listings')}`);
  // copied 상태가 있는 출처끼리는 자연키로 정리하고, 재관측으로 생긴 무효화는 후속 출처까지 반영한다.
  await client.query(`CREATE TEMP TABLE build_deltas ON COMMIT DROP AS ${sources.map(s=>
    `SELECT '${s}'::text AS source_schema,t.* FROM ${quote(s)}.listing_deltas t`).join(' UNION ALL ')};
    CREATE INDEX ON build_deltas(auction_no,item_id,observed_at,reason);
    CREATE TABLE public.listing_deltas AS SELECT d.id,d.auction_no,d.item_id,d.unit_price,d.qty_sold,d.prev_count,d.new_count,d.observed_at,d.reason,
      (SELECT max(x.invalidated_at) FROM build_deltas x WHERE
        (x.auction_no,x.item_id,x.observed_at,x.reason)=(d.auction_no,d.item_id,d.observed_at,d.reason)) AS invalidated_at
    FROM build_deltas d JOIN history_owners o ON d.item_id=o.item_id AND d.source_schema=o.source_schema
      AND tstzrange(o.from_at,o.to_at,'[)') @> d.observed_at`);
  await client.query(`CREATE TABLE public.collection_runs AS SELECT id,item_id,source,started_at,finished_at,sold_rows,sold_new,
    sold_span_min,saturated,listing_rows,deltas_found,CASE WHEN status='failed' THEN 'archived failure' ELSE NULL END AS error
    FROM (${current('collection_quality')}) q`);
  const globalSource = globals.at(-1)!.source;
  for(const table of ['events','research_forecast_batches','research_actuals','market_rankings'])
    await client.query(`CREATE TABLE public.${quote(table)} AS SELECT * FROM ${quote(globalSource)}.${quote(table)}`);
  for(const [table,time] of [['legendary_card_floor','captured_at'],['legendary_card_scans','started_at']]) {
    await client.query(`CREATE TABLE public.${quote(table)} (LIKE ${quote(sources[0])}.${quote(table)})`);
    for(const epoch of globals) await client.query(`INSERT INTO public.${quote(table)} SELECT * FROM ${quote(epoch.source)}.${quote(table)}
      WHERE tstzrange($1,$2,'[)') @> ${quote(time)} AND ${quote(time)}<=$3`,[epoch.from,epoch.to,asOf]);
  }
  // 소스별 점검을 5분 구간에서 한 번씩 합친다. 한 출처의 점검이 빠지면 정상으로 계산하지 않는다.
  await client.query(`CREATE TEMP TABLE build_health ON COMMIT DROP AS ${activeSources.map(s=>
    `SELECT '${s}'::text AS source_schema,h.* FROM ${quote(s)}.collection_health h`).join(' UNION ALL ')}`);
  await client.query(`CREATE TABLE public.collection_health AS WITH latest AS (
      SELECT DISTINCT ON(source_schema,date_bin(interval '5 minutes',checked_at,'2000-01-01'::timestamptz)) *,
        date_bin(interval '5 minutes',checked_at,'2000-01-01'::timestamptz) AS slot
      FROM build_health ORDER BY source_schema,date_bin(interval '5 minutes',checked_at,'2000-01-01'::timestamptz),checked_at DESC
    ) SELECT max(checked_at) checked_at,
      CASE WHEN count(*)=$1 THEN max(gap_min) ELSE NULL END gap_min,
      CASE WHEN count(*)=$1 AND count(stale_items)=$1 THEN sum(stale_items)::int ELSE NULL END stale_items
    FROM latest GROUP BY slot`,[activeSources.length]);
  await installBuildClock(client);
  return { trades,snapshots,asOf,through:state.refreshed_at.toISOString() };
}
