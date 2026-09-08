import type { PoolClient } from 'pg';

/** 호출자의 읽기 전용 스냅샷에서, 복구하지 않고 저장된 값을 대조한다. */
export async function checkCandles(client: PoolClient) {
  const state = (await client.query<{
    raw_from: Date; refreshed_at: Date | null; through: Date | null; checked_at: Date;
  }>(`SELECT raw_from, refreshed_at, date_trunc('hour', refreshed_at) AS through,
             now() AS checked_at FROM candle_pipeline_state WHERE singleton`)).rows[0];
  if (!state?.refreshed_at || !state.through) throw new Error('시간봉 전체 집계 성공 기록이 없습니다.');
  const result = (await client.query<{ bars: number; mismatches: number }>(`
    WITH raw AS (
      SELECT item_id, date_trunc('hour', sold_date) AS hour,
             (array_agg(unit_price ORDER BY sold_date, id))[1] AS o,
             MAX(unit_price) AS h, MIN(unit_price) AS l,
             (array_agg(unit_price ORDER BY sold_date DESC, id DESC))[1] AS c,
             SUM(unit_price::numeric * count) / SUM(count) AS vwap,
             SUM(count)::int AS qty, COUNT(*)::int AS n
      FROM trades WHERE sold_date >= $1 AND sold_date < $2 GROUP BY 1,2
    ), stored AS (
      SELECT * FROM candles_1h WHERE hour >= $1 AND hour < $2
    )
    SELECT (SELECT COUNT(*)::int FROM raw) AS bars,
           COUNT(*) FILTER (WHERE r.item_id IS NULL OR b.item_id IS NULL
             OR (r.o,r.h,r.l,r.c,r.vwap,r.qty,r.n)
                IS DISTINCT FROM (b.o,b.h,b.l,b.c,b.vwap,b.qty,b.n))::int AS mismatches
    FROM raw r FULL JOIN stored b USING(item_id,hour)`, [state.raw_from, state.through])).rows[0];
  return {
    checkedAt: state.checked_at.toISOString(), from: state.raw_from.toISOString(),
    through: state.through.toISOString(), refreshedAt: state.refreshed_at.toISOString(),
    ...result,
  };
}
