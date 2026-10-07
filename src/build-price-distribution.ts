import type { Client } from 'pg';

// 통합 빌드의 임시 DB에서만 실행한다. 운영 원본 조회나 보존 범위를 늘리지 않는다.
export async function buildPriceDistribution(client: Client, schema: 'public' | 'display' = 'public') {
  await client.query(`CREATE TABLE ${schema}.price_distributions AS
    WITH bins AS (
      SELECT t.item_id, g.kind,
        CASE WHEN g.kind='day' THEN date_trunc('day',t.sold_date AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
          ELSE date_trunc('hour',t.sold_date) END AS bucket,
        t.unit_price, SUM(t.count)::numeric AS qty, COUNT(*)::bigint AS n
      FROM ${schema}.trades t JOIN public.items i USING(item_id)
      CROSS JOIN (VALUES ('day'),('hour')) g(kind)
      WHERE i.category<>'카드' AND i.tracked
        AND t.id<=(SELECT raw_max_id FROM public.candle_pipeline_state WHERE singleton)
      GROUP BY 1,2,3,4
    ), ranked AS (
      SELECT *,SUM(qty) OVER(PARTITION BY item_id,kind,bucket ORDER BY unit_price ROWS UNBOUNDED PRECEDING) AS cumulative,
        SUM(qty) OVER(PARTITION BY item_id,kind,bucket) AS total FROM bins
    ), quantiles AS (
      SELECT item_id,kind,bucket,SUM(n)::int AS n,SUM(qty)::float8 AS qty,
        MIN(unit_price) FILTER(WHERE cumulative>=total*.25)::float8 AS q25,
        MIN(unit_price) FILTER(WHERE cumulative>=total*.50)::float8 AS median,
        MIN(unit_price) FILTER(WHERE cumulative>=total*.75)::float8 AS q75,
        MIN(unit_price)::float8 AS l,MAX(unit_price)::float8 AS h
      FROM ranked GROUP BY 1,2,3
    ), expected AS (
      SELECT b.item_id,g.kind,
        CASE WHEN g.kind='day' THEN date_trunc('day',b.hour AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
          ELSE b.hour END AS bucket,
        SUM(b.n)::int AS n,SUM(b.qty)::float8 AS qty,MIN(b.l)::float8 AS l,MAX(b.h)::float8 AS h,
        (SUM(b.vwap*b.qty)/SUM(b.qty))::float8 AS vwap
      FROM ${schema}.candles_1h b JOIN public.items i USING(item_id)
      CROSS JOIN (VALUES ('day'),('hour')) g(kind)
      WHERE i.category<>'카드' AND i.tracked GROUP BY 1,2,3
    )
    SELECT e.*,CASE WHEN (q.n,q.qty,q.l,q.h)=(e.n,e.qty,e.l,e.h) THEN q.q25 END AS q25,
      CASE WHEN (q.n,q.qty,q.l,q.h)=(e.n,e.qty,e.l,e.h) THEN q.median END AS median,
      CASE WHEN (q.n,q.qty,q.l,q.h)=(e.n,e.qty,e.l,e.h) THEN q.q75 END AS q75
    FROM expected e LEFT JOIN quantiles q USING(item_id,kind,bucket);
    CREATE UNIQUE INDEX ON ${schema}.price_distributions(item_id,kind,bucket)`);
}
