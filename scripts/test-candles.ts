import assert from 'node:assert/strict';
import { pool } from '../src/db.ts';

const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const bounds = await client.query<{ from_time: Date }>(`
    SELECT date_trunc('hour', MIN(sold_date)) + interval '1 hour' AS from_time
    FROM trades`);
  const from = bounds.rows[0]?.from_time;
  assert(from, '비교할 원본 체결이 없습니다.');

  await client.query('SELECT refresh_candles_1h($1)', [from]);
  const result = await client.query<{
    raw_bars: number; candle_bars: number; mismatches: number;
    raw_qty: string; candle_qty: string; raw_n: string; candle_n: string;
  }>(`
    WITH raw AS (
      SELECT item_id, date_trunc('hour', sold_date) AS bucket,
             (array_agg(unit_price ORDER BY sold_date, id))[1] AS o,
             MAX(unit_price) AS h, MIN(unit_price) AS l,
             (array_agg(unit_price ORDER BY sold_date DESC, id DESC))[1] AS c,
             SUM(unit_price::numeric*count)/SUM(count) AS vwap,
             SUM(count)::int AS qty, COUNT(*)::int AS n
      FROM trades WHERE sold_date >= $1 GROUP BY 1,2
    ), compared AS (
      SELECT r.*, b.item_id AS candle_item_id,
             b.o AS candle_o, b.h AS candle_h, b.l AS candle_l, b.c AS candle_c,
             b.vwap AS candle_vwap, b.qty AS candle_qty, b.n AS candle_n
      FROM raw r FULL JOIN candles_1h b
        ON b.item_id = r.item_id AND b.hour = r.bucket
      WHERE COALESCE(r.bucket, b.hour) >= $1
    )
    SELECT (SELECT COUNT(*)::int FROM raw) AS raw_bars,
           (SELECT COUNT(*)::int FROM candles_1h WHERE hour >= $1) AS candle_bars,
           COUNT(*) FILTER (WHERE item_id IS NULL OR candle_item_id IS NULL
             OR o IS DISTINCT FROM candle_o OR h IS DISTINCT FROM candle_h
             OR l IS DISTINCT FROM candle_l OR c IS DISTINCT FROM candle_c
             OR vwap IS DISTINCT FROM candle_vwap OR qty IS DISTINCT FROM candle_qty
             OR n IS DISTINCT FROM candle_n)::int AS mismatches,
           SUM(qty)::bigint AS raw_qty, SUM(candle_qty)::bigint AS candle_qty,
           SUM(n)::bigint AS raw_n, SUM(candle_n)::bigint AS candle_n
    FROM compared`, [from]);

  const row = result.rows[0];
  assert.equal(row.mismatches, 0);
  assert.equal(row.raw_bars, row.candle_bars);
  assert.equal(row.raw_qty, row.candle_qty);
  assert.equal(row.raw_n, row.candle_n);
  await client.query('COMMIT');
  console.log(`시간봉 집계 테스트 통과 — ${row.raw_bars.toLocaleString()}봉 · ${Number(row.raw_qty).toLocaleString()}개`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
