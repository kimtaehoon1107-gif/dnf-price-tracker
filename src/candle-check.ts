import type { PoolClient } from 'pg';

// 시간당 집계 주기에 30분의 지연 여유를 더한다.
export const CANDLE_MAX_AGE_MINUTES = 90;
export function candleFreshness(refreshedAt: string | Date | null, asOf = Date.now()) {
  const ageMinutes = refreshedAt === null ? null : (asOf - new Date(refreshedAt).getTime()) / 60000;
  return { ageMinutes, maxAgeMinutes: CANDLE_MAX_AGE_MINUTES,
    stale: ageMinutes === null || !Number.isFinite(ageMinutes) || ageMinutes > CANDLE_MAX_AGE_MINUTES };
}

/** 호출자의 읽기 전용 스냅샷에서, 복구하지 않고 저장된 값을 대조한다. */
export async function checkCandles(client: PoolClient) {
  const state = (await client.query<{
    raw_from: Date; raw_max_id: string | null; refreshed_at: Date | null; through: Date | null; checked_at: Date;
  }>(`SELECT raw_from, raw_max_id, refreshed_at, date_trunc('hour', refreshed_at) AS through,
             now() AS checked_at FROM candle_pipeline_state WHERE singleton`)).rows[0];
  if (!state?.refreshed_at || !state.through) throw new Error('시간봉 전체 집계 성공 기록이 없습니다.');
  if (state.raw_max_id === null) throw new Error('시간봉 집계의 원본 ID 경계가 없습니다. 전체 집계가 필요합니다.');
  const result = (await client.query<{ bars: number; mismatches: number; pendingBars: number; pendingTrades: number }>(`
    WITH raw AS (
      SELECT item_id, date_trunc('hour', sold_date) AS hour,
             (array_agg(unit_price ORDER BY sold_date, id))[1] AS o,
             MAX(unit_price) AS h, MIN(unit_price) AS l,
             (array_agg(unit_price ORDER BY sold_date DESC, id DESC))[1] AS c,
             SUM(unit_price::numeric * count) / SUM(count) AS vwap,
             SUM(count)::int AS qty, COUNT(*)::int AS n
      FROM trades WHERE sold_date >= $1 AND sold_date < $2 AND id <= $3 GROUP BY 1,2
    ), stored AS (
      SELECT * FROM candles_1h WHERE hour >= $1 AND hour < $2
    ), pending AS (
      SELECT item_id,date_trunc('hour',sold_date) AS hour,COUNT(*)::int AS n
      FROM trades WHERE sold_date >= $1 AND sold_date < $2 AND id > $3 GROUP BY 1,2
    )
    SELECT (SELECT COUNT(*)::int FROM raw) AS bars,
           (SELECT COUNT(*)::int FROM pending) AS "pendingBars",
           (SELECT COALESCE(SUM(n),0)::int FROM pending) AS "pendingTrades",
           COUNT(*) FILTER (WHERE r.item_id IS NULL OR b.item_id IS NULL
             OR (r.o,r.h,r.l,r.c,r.vwap,r.qty,r.n)
                IS DISTINCT FROM (b.o,b.h,b.l,b.c,b.vwap,b.qty,b.n))::int AS mismatches
    FROM raw r FULL JOIN stored b USING(item_id,hour)`, [state.raw_from, state.through, state.raw_max_id])).rows[0];
  return {
    checkedAt: state.checked_at.toISOString(), from: state.raw_from.toISOString(),
    through: state.through.toISOString(), refreshedAt: state.refreshed_at.toISOString(),
    rawMaxId: state.raw_max_id,
    ...candleFreshness(state.refreshed_at, state.checked_at.getTime()),
    ...result,
  };
}
