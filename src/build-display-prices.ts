import type { Client } from 'pg';
import { buildPriceDistribution } from './build-price-distribution.ts';

// Only the disposable unified build DB is changed. Source trades and candles stay intact.
// The unweighted median is computed from all available trades within each KST day.
export async function buildDisplayPrices(client: Client) {
  await client.query(`CREATE SCHEMA display;
    CREATE TABLE display.cleaning_days AS
    WITH raw AS (
      SELECT t.item_id,(sold_date AT TIME ZONE 'Asia/Seoul')::date AS day,
        percentile_cont(.5) WITHIN GROUP(ORDER BY unit_price) AS median,
        count(*)::int AS observed_n,sum(count)::bigint AS observed_qty,
        count(*) FILTER(WHERE id<=s.raw_max_id)::int AS eligible_n,
        coalesce(sum(count) FILTER(WHERE id<=s.raw_max_id),0)::bigint AS eligible_qty
      FROM public.trades t JOIN public.items i USING(item_id)
      CROSS JOIN public.candle_pipeline_state s
      WHERE i.category<>'카드' AND s.singleton
      GROUP BY 1,2
    ), expected AS (
      SELECT b.item_id,(hour AT TIME ZONE 'Asia/Seoul')::date AS day,
        sum(n)::int AS n,sum(qty)::bigint AS qty
      FROM public.candles_1h b JOIN public.items i USING(item_id)
      WHERE i.category<>'카드' GROUP BY 1,2
    ) SELECT coalesce(r.item_id,e.item_id) AS item_id,coalesce(r.day,e.day) AS day,
      r.median,coalesce(r.observed_n,0) AS observed_n,coalesce(r.observed_qty,0) AS observed_qty,
      (r.eligible_n=coalesce(e.n,0) AND r.eligible_qty=coalesce(e.qty,0)) IS TRUE AS verified,
      0::int AS excluded_n,0::bigint AS excluded_qty
    FROM raw r FULL JOIN expected e USING(item_id,day);
    CREATE UNIQUE INDEX ON display.cleaning_days(item_id,day);
    UPDATE display.cleaning_days d SET excluded_n=x.n,excluded_qty=x.qty
    FROM (
      SELECT t.item_id,d.day,count(*)::int AS n,sum(t.count)::bigint AS qty
      FROM public.trades t JOIN display.cleaning_days d
        ON t.item_id=d.item_id AND (t.sold_date AT TIME ZONE 'Asia/Seoul')::date=d.day
      WHERE d.verified AND (t.unit_price<d.median/10 OR t.unit_price>d.median*10)
      GROUP BY 1,2
    ) x WHERE d.item_id=x.item_id AND d.day=x.day;
    CREATE TABLE display.trades AS
      SELECT t.* FROM public.trades t JOIN public.items i USING(item_id)
      LEFT JOIN display.cleaning_days d ON t.item_id=d.item_id
        AND (t.sold_date AT TIME ZONE 'Asia/Seoul')::date=d.day
      WHERE i.category='카드' OR (d.verified AND t.unit_price BETWEEN d.median/10 AND d.median*10);
    CREATE UNIQUE INDEX ON display.trades(id);
    CREATE INDEX ON display.trades(item_id,sold_date);
    CREATE TABLE display.candles_1h AS
      SELECT t.item_id,date_trunc('hour',sold_date) AS hour,
        (array_agg(unit_price ORDER BY sold_date,id))[1] AS o,max(unit_price) AS h,min(unit_price) AS l,
        (array_agg(unit_price ORDER BY sold_date DESC,id DESC))[1] AS c,
        sum(unit_price::numeric*count)/sum(count) AS vwap,sum(count)::int AS qty,count(*)::int AS n,
        true AS raw_complete
      FROM display.trades t CROSS JOIN public.candle_pipeline_state s
      WHERE s.singleton AND t.id<=s.raw_max_id GROUP BY 1,2;
    CREATE UNIQUE INDEX ON display.candles_1h(item_id,hour)`);
  await buildPriceDistribution(client, 'display');
}
