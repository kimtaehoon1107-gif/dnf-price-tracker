import type { PoolClient } from 'pg';

const DAY = 86_400_000;
// KST 06:00 = UTC 21:00 on the previous calendar day.
export function turnoverWindow(through: string) {
  const time = Date.parse(through);
  if (!Number.isFinite(time)) throw new Error('Invalid candle cutoff');
  const end = Math.floor((time + 3 * 3_600_000) / DAY) * DAY - 3 * 3_600_000;
  return { start: new Date(end - 30 * DAY).toISOString(), end: new Date(end).toISOString() };
}

export async function gameDayTurnover(client: PoolClient, through: string) {
  const window = turnoverWindow(through);
  const rows = (await client.query<{
    day: string; amount: number | null; trades: number; observedItems: number; observedHours: number; trackedItems: number;
  }>(`
    WITH selected AS (SELECT item_id FROM public.items WHERE tracked AND category <> '카드'),
    daily AS (
      SELECT (b.hour AT TIME ZONE 'Asia/Seoul' - interval '6 hours')::date AS day,
        round(sum(b.vwap * b.qty))::float8 AS amount, sum(b.n)::int AS trades,
        count(DISTINCT b.item_id)::int AS "observedItems", count(DISTINCT b.hour)::int AS "observedHours"
      FROM public.candles_1h b JOIN selected USING(item_id)
      WHERE b.hour >= $1::timestamptz AND b.hour < $2::timestamptz GROUP BY 1
    ), days AS (
      SELECT (($1::timestamptz AT TIME ZONE 'Asia/Seoul')::date + i)::date AS day
      FROM generate_series(0,29) i
    ) SELECT to_char(days.day,'YYYY-MM-DD') AS day, d.amount,
      coalesce(d.trades,0) AS trades, coalesce(d."observedItems",0) AS "observedItems",
      coalesce(d."observedHours",0) AS "observedHours", (SELECT count(*)::int FROM selected) AS "trackedItems"
    FROM days LEFT JOIN daily d USING(day) ORDER BY days.day`, [window.start, window.end])).rows;
  return { timezone: 'Asia/Seoul', startHour: 6, through, ...window,
    trackedItems: rows[0]?.trackedItems ?? 0,
    days: rows.map(({ trackedItems, ...day }) => day) };
}
