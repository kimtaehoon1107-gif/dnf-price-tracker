// Supabase를 읽어 정적 사이트를 굽는다.
//
// 서버를 두지 않는 이유: 조회 트래픽이 사실상 없는데 상시 서버를 굴릴 이유가 없고,
// 수집 Actions가 어차피 돌기 때문에 그때 같이 구우면 갱신 주기가 같아진다.
// 결과적으로 서버 0대, 비용 0원, 첫 로딩은 정적 파일 속도가 된다.
//
//   node --env-file=.env --no-warnings web/build.ts

import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { pool } from '../src/db.ts';
import type { QueryResultRow } from 'pg';
import { checkCandles } from '../src/candle-check.ts';
import { forecast, type Point, type Forecast } from '../src/forecast.ts';
import { holmAdjusted, longestCompleteHours, varianceRatio } from '../src/market-logic.ts';

const client = await pool.connect();
const query = <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => client.query<T>(text, params);
try {
await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const quality = await checkCandles(client);
if (quality.mismatches) throw new Error(`시간봉 정합성 불일치 ${quality.mismatches}봉 — 새 분석 배포를 중단합니다.`);
if (quality.stale) throw new Error(`시간봉 집계가 ${quality.maxAgeMinutes}분을 초과해 지연됐습니다 — 새 분석 배포를 중단합니다.`);
const collection = (await query<{ last_success: Date | null; stale: string[] }>(`
  WITH last AS (
    SELECT i.item_name, i.poll_interval_sec, MAX(r.finished_at) AS t
    FROM items i LEFT JOIN collection_runs r ON r.item_id=i.item_id
      AND r.error IS NULL AND r.finished_at IS NOT NULL
    WHERE i.tracked GROUP BY i.item_id
  ) SELECT MAX(t) AS last_success,
      COALESCE(array_agg(item_name ORDER BY item_name) FILTER (
        WHERE t IS NULL OR t < now()-make_interval(secs=>poll_interval_sec*5)), '{}') AS stale
    FROM last`)).rows[0];
const OUT = 'dist';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/data/series`, { recursive: true });

// ── 아이템 요약 ────────────────────────────────────────────────
const items = (await query<{
  item_id: string; item_name: string; item_rarity: string; item_type_detail: string;
  role: string; category: string; slot: string | null; job_role: string | null;
  is_final: boolean; final_since: string | null; key_stat: string | null; key_stat_max: string | null;
  price_basis: 'trade' | 'ask0';
  trades: number; span_days: number; last_price: number;
  last_trade_at: Date | null; vwap1h: number | null; trades1h: number; api_qty1h: number;
  vwap24: number | null; vwap_prev: number | null; api_qty24: number;
  listings: number; min_ask: number | null; median_ask: number | null;
  max_upgrade: number | null; max_trades: number; max_span_days: number;
  max_last_price: number | null; max_vwap24: number | null; max_vwap_prev: number | null;
  max_listings: number; max_min_ask: number | null; max_median_ask: number | null;
}>(`
  WITH trade_agg AS (
    SELECT t.item_id,
           COUNT(*)::int AS trades,
           (EXTRACT(EPOCH FROM MAX(sold_date)-MIN(sold_date))/86400)::float8 AS span_days,
           (SUM(unit_price::numeric*count) FILTER (WHERE sold_date > now()-interval '24 hours')
             / NULLIF(SUM(count) FILTER (WHERE sold_date > now()-interval '24 hours'),0))::float8 AS vwap24,
           (SUM(unit_price::numeric*count) FILTER (WHERE sold_date BETWEEN now()-interval '48 hours' AND now()-interval '24 hours')
             / NULLIF(SUM(count) FILTER (WHERE sold_date BETWEEN now()-interval '48 hours' AND now()-interval '24 hours'),0))::float8 AS vwap_prev,
           COALESCE(SUM(count) FILTER (WHERE sold_date > now()-interval '24 hours'),0)::int AS api_qty24
    FROM trades t JOIN items i USING (item_id)
    WHERE i.category <> '카드'
    GROUP BY t.item_id
  ),
  card_agg AS (
    SELECT s.item_id,
           COUNT(*)::int AS trades,
           (EXTRACT(EPOCH FROM MAX(s.captured_at)-MIN(s.captured_at))/86400)::float8 AS span_days,
           AVG(s.min_unit_price) FILTER (WHERE s.captured_at > now()-interval '24 hours')::float8 AS vwap24,
           AVG(s.min_unit_price) FILTER (WHERE s.captured_at BETWEEN now()-interval '48 hours' AND now()-interval '24 hours')::float8 AS vwap_prev,
           0::int AS api_qty24
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE i.category = '카드' AND (s.upgrade = 0 OR s.upgrade IS NULL) AND s.min_unit_price > 0
    GROUP BY s.item_id
  ),
  agg AS (
    SELECT * FROM trade_agg UNION ALL SELECT * FROM card_agg
  ),
  card_max_agg AS (
    SELECT s.item_id,
           COUNT(*)::int AS trades,
           (EXTRACT(EPOCH FROM MAX(s.captured_at)-MIN(s.captured_at))/86400)::float8 AS span_days,
           AVG(s.min_unit_price) FILTER (WHERE s.captured_at > now()-interval '24 hours')::float8 AS vwap24,
           AVG(s.min_unit_price) FILTER (WHERE s.captured_at BETWEEN now()-interval '48 hours' AND now()-interval '24 hours')::float8 AS vwap_prev
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE i.category = '카드' AND s.upgrade > 0 AND s.upgrade = s.upgrade_max
      AND s.min_unit_price > 0
    GROUP BY s.item_id
  ),
  last_snap AS (
    SELECT DISTINCT ON (s.item_id) s.item_id, s.listing_count, s.min_unit_price, s.median
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE i.category <> '카드' OR s.upgrade = 0
    ORDER BY s.item_id, s.captured_at DESC
  ),
  last_max_snap AS (
    SELECT DISTINCT ON (s.item_id) s.item_id, s.upgrade, s.upgrade_max,
           s.listing_count, s.min_unit_price, s.median
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE i.category = '카드' AND s.upgrade > 0 AND s.upgrade = s.upgrade_max
    ORDER BY s.item_id, s.captured_at DESC
  ),
  recent_trade AS (
    SELECT t.item_id,
           (SUM(t.unit_price::numeric*t.count) / NULLIF(SUM(t.count),0))::float8 AS vwap1h,
           COUNT(*)::int AS trades1h, SUM(t.count)::int AS api_qty1h
    FROM trades t JOIN items i USING (item_id)
    WHERE i.category <> '카드' AND t.sold_date > now()-interval '1 hour' AND t.sold_date <= now()
    GROUP BY t.item_id
  ),
  last_trade AS (
    SELECT DISTINCT ON (t.item_id) t.item_id, t.unit_price, t.sold_date
    FROM trades t JOIN items i USING (item_id)
    WHERE i.category <> '카드'
    ORDER BY t.item_id, t.sold_date DESC, t.id DESC
  )
  SELECT i.item_id, i.item_name, i.item_rarity, i.item_type_detail, i.role,
         COALESCE(i.category,'기타') AS category, i.slot, i.job_role,
         i.is_final, to_char(i.final_since,'YYYY-MM-DD') AS final_since, i.key_stat, i.key_stat_max,
         CASE WHEN i.category = '카드' THEN 'ask0' ELSE 'trade' END AS price_basis,
         COALESCE(a.trades,0) AS trades, COALESCE(a.span_days,0) AS span_days,
         COALESCE(CASE WHEN i.category = '카드' THEN ls.min_unit_price ELSE lt.unit_price END,0)::float8 AS last_price,
         lt.sold_date AS last_trade_at, rt.vwap1h,
         COALESCE(rt.trades1h,0) AS trades1h, COALESCE(rt.api_qty1h,0) AS api_qty1h,
         a.vwap24, a.vwap_prev, COALESCE(a.api_qty24,0) AS api_qty24,
         COALESCE(ls.listing_count,0) AS listings,
         ls.min_unit_price::float8 AS min_ask, ls.median::float8 AS median_ask,
         COALESCE(lms.upgrade, lms.upgrade_max)::int AS max_upgrade,
         COALESCE(cma.trades,0) AS max_trades, COALESCE(cma.span_days,0) AS max_span_days,
         lms.min_unit_price::float8 AS max_last_price,
         cma.vwap24 AS max_vwap24, cma.vwap_prev AS max_vwap_prev,
         COALESCE(lms.listing_count,0) AS max_listings,
         lms.min_unit_price::float8 AS max_min_ask, lms.median::float8 AS max_median_ask
  FROM items i
  LEFT JOIN agg a USING (item_id)
  LEFT JOIN card_max_agg cma USING (item_id)
  LEFT JOIN last_snap ls USING (item_id)
  LEFT JOIN last_max_snap lms USING (item_id)
  LEFT JOIN last_trade lt USING (item_id)
  LEFT JOIN recent_trade rt USING (item_id)
  WHERE i.tracked ORDER BY i.item_name`)).rows;

// ── 아이템별 일봉 / 시간봉 ─────────────────────────────────────
const daily = (await query<{
  item_id: string; d: string; o: number; h: number; l: number; c: number; vwap: number; qty: number; n: number;
}>(`
  WITH trade_daily AS (
    SELECT b.item_id,
         to_char((hour AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS d,
         (array_agg(o ORDER BY hour))[1]::float8 AS o,
         MAX(h)::float8 AS h, MIN(l)::float8 AS l,
         (array_agg(c ORDER BY hour DESC))[1]::float8 AS c,
         (SUM(vwap*qty)/SUM(qty))::float8 AS vwap,
         SUM(qty)::int AS qty, SUM(n)::int AS n
    FROM candles_1h b JOIN items i USING (item_id)
    WHERE i.category <> '카드'
    GROUP BY 1,2
  ), card_daily AS (
    SELECT s.item_id,
           to_char((s.captured_at AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS d,
           (array_agg(s.min_unit_price ORDER BY s.captured_at, s.id))[1]::float8 AS o,
           MAX(s.min_unit_price)::float8 AS h, MIN(s.min_unit_price)::float8 AS l,
           (array_agg(s.min_unit_price ORDER BY s.captured_at DESC, s.id DESC))[1]::float8 AS c,
           AVG(s.min_unit_price)::float8 AS vwap, 0::int AS qty, COUNT(*)::int AS n
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE i.category = '카드' AND (s.upgrade = 0 OR s.upgrade IS NULL) AND s.min_unit_price > 0
    GROUP BY 1,2
  )
  SELECT * FROM trade_daily UNION ALL SELECT * FROM card_daily ORDER BY 1,2`)).rows;

const hourly = (await query<{ item_id: string; t: string; vwap: number; qty: number }>(`
  WITH trade_hourly AS (
    SELECT b.item_id,
         to_char(hour AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
         vwap::float8 AS vwap, qty
    FROM candles_1h b JOIN items i USING (item_id)
    WHERE hour >= date_trunc('hour', now() - interval '7 days') AND i.category <> '카드'
  ), card_hourly AS (
    SELECT s.item_id,
           to_char(date_trunc('hour', s.captured_at AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
           AVG(s.min_unit_price)::float8 AS vwap, 0::int AS qty
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE s.captured_at > now() - interval '7 days'
      AND i.category = '카드' AND (s.upgrade = 0 OR s.upgrade IS NULL) AND s.min_unit_price > 0
    GROUP BY 1,2
  )
  SELECT * FROM trade_hourly UNION ALL SELECT * FROM card_hourly ORDER BY 1,2`)).rows;

const cardDailyMax = (await query<{
  item_id: string; d: string; o: number; h: number; l: number; c: number; vwap: number; qty: number; n: number;
}>(`
  SELECT s.item_id,
         to_char((s.captured_at AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS d,
         (array_agg(s.min_unit_price ORDER BY s.captured_at, s.id))[1]::float8 AS o,
         MAX(s.min_unit_price)::float8 AS h, MIN(s.min_unit_price)::float8 AS l,
         (array_agg(s.min_unit_price ORDER BY s.captured_at DESC, s.id DESC))[1]::float8 AS c,
         AVG(s.min_unit_price)::float8 AS vwap, 0::int AS qty, COUNT(*)::int AS n
  FROM listing_snapshots s JOIN items i USING (item_id)
  WHERE i.category = '카드' AND s.upgrade > 0 AND s.upgrade = s.upgrade_max
    AND s.min_unit_price > 0
  GROUP BY 1,2 ORDER BY 1,2`)).rows;

const cardHourlyMax = (await query<{ item_id: string; t: string; vwap: number; qty: number }>(`
  SELECT s.item_id,
         to_char(date_trunc('hour', s.captured_at AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
         AVG(s.min_unit_price)::float8 AS vwap, 0::int AS qty
  FROM listing_snapshots s JOIN items i USING (item_id)
  WHERE s.captured_at > now() - interval '7 days'
    AND i.category = '카드' AND s.upgrade > 0 AND s.upgrade = s.upgrade_max
    AND s.min_unit_price > 0
  GROUP BY 1,2 ORDER BY 1,2`)).rows;

const askGap = (await query<{
  item_id: string; t: string; min_ask: number; vwap: number; gap: number;
}>(`
  SELECT DISTINCT ON (s.item_id, date_trunc('second', s.captured_at)) s.item_id,
         to_char(s.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
         s.min_unit_price::float8 AS min_ask,
         v.vwap::float8 AS vwap,
         ((s.min_unit_price::numeric / v.vwap - 1) * 100)::float8 AS gap
  FROM listing_snapshots s JOIN items i USING (item_id)
  CROSS JOIN LATERAL (
    SELECT SUM(t.unit_price::numeric*t.count) / NULLIF(SUM(t.count),0) AS vwap
    FROM trades t
    WHERE t.item_id = s.item_id
      AND t.sold_date <= s.captured_at
      AND t.sold_date > s.captured_at - interval '24 hours'
  ) v
  WHERE s.captured_at > now() - interval '7 days'
    AND i.category <> '카드'
    AND s.min_unit_price > 0 AND v.vwap > 0
  ORDER BY s.item_id, date_trunc('second', s.captured_at), s.captured_at DESC`)).rows;

// 매물 소진량은 실제 판매 시각이 아니라 다음 수집에서 발견한 시각에 찍힌다.
// 긴 수집 공백 뒤의 소진을 한 시간의 폭증으로 오해하지 않도록, 각 관측량을
// 직전 스냅샷부터 흐른 시간으로 나눠 시간당 속도로 환산한다.
const depletion = (await query<{
  item_id: string; upgrade: number | null; t: string; qty: number; partial: number; vanished: number;
  observed_min: number; rate: number;
}>(`
  WITH observations AS (
    SELECT s.item_id, s.upgrade, captured_at,
           LAG(captured_at) OVER (PARTITION BY s.item_id, s.upgrade ORDER BY captured_at) AS prev_at
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE captured_at > now() - interval '8 days'
      AND (i.category <> '카드' OR s.upgrade = 0 OR s.upgrade = s.upgrade_max)
  ), deltas AS (
    SELECT d.item_id, l.upgrade, observed_at,
           COALESCE(SUM(qty_sold) FILTER (WHERE reason = 'partial'), 0)::float8 AS partial,
           COALESCE(SUM(qty_sold) FILTER (WHERE reason = 'vanished_before_expiry'), 0)::float8 AS vanished
    FROM listing_deltas d JOIN items i USING (item_id)
    JOIN listings l ON l.auction_no = d.auction_no
    WHERE observed_at > now() - interval '7 days' AND d.invalidated_at IS NULL
      AND (i.category <> '카드' OR l.upgrade = 0 OR l.upgrade = l.upgrade_max)
    GROUP BY d.item_id, l.upgrade, observed_at
  )
  SELECT o.item_id, o.upgrade,
         to_char(date_trunc('hour', o.captured_at AT TIME ZONE 'UTC'),
                 'YYYY-MM-DD"T"HH24:00:00"Z"') AS t,
         SUM(COALESCE(d.partial, 0) + COALESCE(d.vanished, 0))::float8 AS qty,
         SUM(COALESCE(d.partial, 0))::float8 AS partial,
         SUM(COALESCE(d.vanished, 0))::float8 AS vanished,
         (SUM(EXTRACT(EPOCH FROM o.captured_at - o.prev_at)) / 60)::float8 AS observed_min,
         (SUM(COALESCE(d.partial, 0) + COALESCE(d.vanished, 0))
           / NULLIF(SUM(EXTRACT(EPOCH FROM o.captured_at - o.prev_at)) / 3600, 0))::float8 AS rate
  FROM observations o
  LEFT JOIN deltas d ON d.item_id = o.item_id AND d.observed_at = o.captured_at
    AND d.upgrade IS NOT DISTINCT FROM o.upgrade
  WHERE o.captured_at > now() - interval '7 days' AND o.prev_at IS NOT NULL
  GROUP BY o.item_id, o.upgrade, date_trunc('hour', o.captured_at AT TIME ZONE 'UTC')
  ORDER BY o.item_id, o.upgrade, 3`)).rows;

const depth = (await query<{ item_id: string; price: number; qty: number }>(`
  SELECT l.item_id, l.unit_price::float8 AS price, SUM(l.cur_count)::float8 AS qty
  FROM listings l JOIN items i USING (item_id)
  WHERE l.closed_at IS NULL AND l.cur_count > 0 AND l.unit_price > 0
    AND i.category = ANY($1)
  GROUP BY l.item_id, l.unit_price
  ORDER BY l.item_id, l.unit_price`, [['재료·소모품', '소울 결정']])).rows;

const events = (await query<{
  id: string; name: string; type: string;
  announced: string | null; starts: string | null; ends: string | null;
  related_item_ids: string[] | null; source_url: string | null;
}>(`
  SELECT id::text, name, type,
         CASE WHEN announced_at IS NULL THEN NULL ELSE
           to_char(announced_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') END AS announced,
         CASE WHEN starts_at IS NULL THEN NULL ELSE
           to_char(starts_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') END AS starts,
         CASE WHEN ends_at IS NULL THEN NULL ELSE
           to_char(ends_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') END AS ends,
         related_item_ids, source_url
  FROM events
  WHERE type = ANY($1)
  ORDER BY COALESCE(announced_at, starts_at, ends_at) DESC, id DESC`,
[['퍼스트서버', '대규모', '주요', '패키지']])).rows;

const byItem = <T extends { item_id: string }>(rows: T[]) => {
  const m = new Map<string, Omit<T, 'item_id'>[]>();
  for (const { item_id, ...rest } of rows) {
    if (!m.has(item_id)) m.set(item_id, []);
    m.get(item_id)!.push(rest as Omit<T, 'item_id'>);
  }
  return m;
};
const dailyBy = byItem(daily);
const hourlyBy = byItem(hourly);
const cardDailyMaxBy = byItem(cardDailyMax);
const cardHourlyMaxBy = byItem(cardHourlyMax);
const askGapBy = byItem(askGap);
const depletionBy = byItem(depletion.filter((row) => row.upgrade === null || row.upgrade === 0));
const cardDepletionMaxBy = byItem(depletion.filter((row) => row.upgrade !== null && row.upgrade > 0));
const depthBy = byItem(depth);
const eventsBy = new Map<string, typeof events>();
for (const event of events) {
  const related = event.related_item_ids?.length ? event.related_item_ids : items.map((item) => item.item_id);
  for (const itemId of related) {
    if (!eventsBy.has(itemId)) eventsBy.set(itemId, []);
    eventsBy.get(itemId)!.push(event);
  }
}

// ── 요일 효과 ──────────────────────────────────────────────────
const WEEKDAY_MIN_HISTORY_DAYS = 14;
const WEEKDAY_MIN_TRADES = 25;
const weekdayEligibleSql = `
  SELECT t.item_id, i.category
  FROM trades t JOIN items i USING (item_id)
  WHERE i.category <> '카드'
  GROUP BY t.item_id, i.category
  HAVING MAX(sold_date) - MIN(sold_date) > make_interval(days => $1::int)
     AND COUNT(*) >= $2`;

const weekday = (await query<{ dow: string; k: number; n: number; ret: number; se: number; vol: number }>(`
  WITH span AS (${weekdayEligibleSql}),
  d AS (SELECT t.item_id,(t.sold_date AT TIME ZONE 'Asia/Seoul')::date dd,
    SUM(t.unit_price::numeric*t.count)/SUM(t.count) vwap, SUM(t.count)::int qty
    FROM trades t JOIN span s USING (item_id)
    WHERE (t.sold_date AT TIME ZONE 'Asia/Seoul')::date
          < (now() AT TIME ZONE 'Asia/Seoul')::date
    GROUP BY 1,2),
  base AS (SELECT item_id, AVG(vwap) m, AVG(qty) mq FROM d GROUP BY 1),
  norm AS (SELECT d.dd, LN(d.vwap/b.m) lr, d.qty/NULLIF(b.mq,0) rq
    FROM d JOIN base b USING (item_id) WHERE b.m>0 AND d.vwap>0)
  SELECT to_char(dd,'Dy') dow, EXTRACT(isodow FROM dd)::int k, COUNT(*)::int n,
    (AVG(lr)*100)::float8 ret, (STDDEV(lr)/SQRT(COUNT(*))*100)::float8 se, AVG(rq)::float8 vol
  FROM norm GROUP BY 1,2 ORDER BY 2`, [WEEKDAY_MIN_HISTORY_DAYS, WEEKDAY_MIN_TRADES])).rows;

const weekdaySampleDb = (await query<{
  item_count: number; item_days: number; span_days: number;
  first_day: string | null; last_day: string | null; categories: Record<string, number>;
}>(`
  WITH span AS (${weekdayEligibleSql}),
  d AS (
    SELECT t.item_id, (t.sold_date AT TIME ZONE 'Asia/Seoul')::date dd
    FROM trades t JOIN span s USING (item_id)
    WHERE (t.sold_date AT TIME ZONE 'Asia/Seoul')::date
          < (now() AT TIME ZONE 'Asia/Seoul')::date
    GROUP BY 1,2
  ), category_counts AS (
    SELECT category, COUNT(*)::int n FROM span GROUP BY category
  )
  SELECT (SELECT COUNT(*)::int FROM span) item_count,
         (SELECT COUNT(*)::int FROM d) item_days,
         COALESCE((SELECT MAX(dd) - MIN(dd) + 1 FROM d), 0)::int span_days,
         (SELECT to_char(MIN(dd), 'YYYY-MM-DD') FROM d) first_day,
         (SELECT to_char(MAX(dd), 'YYYY-MM-DD') FROM d) last_day,
         COALESCE((SELECT jsonb_object_agg(category, n) FROM category_counts), '{}'::jsonb) categories`,
  [WEEKDAY_MIN_HISTORY_DAYS, WEEKDAY_MIN_TRADES])).rows[0];
const weekdaySample = {
  ...weekdaySampleDb,
  minHistoryDays: WEEKDAY_MIN_HISTORY_DAYS,
  minTrades: WEEKDAY_MIN_TRADES,
  // 양측 alpha=0.05의 1.96과 검정력 80%의 0.84를 더한 값이다.
  // 표본이 늘어 SE가 줄면 화면의 최소 탐지 가능 효과도 자동으로 내려간다.
  mde: weekday.length
    ? 2.80 * weekday.reduce((sum, row) => sum + row.se, 0) / weekday.length
    : null,
};

// ── 아이템별 시계열 + 예측 ─────────────────────────────────────
const forecasts = new Map<string, Forecast>();
const todayKst = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const completeDay = new Date(quality.through).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
// 과거 평가일마다 당시 자격을 다시 판단한다. 현재 예측 가능한 종목만 추리면
// 미래의 유동성·이력 정보가 공통 요일 계수에 들어가므로 전체 체결 종목을 넘긴다.
const market = new Map(items.filter((it) => it.price_basis === 'trade').map((it) =>
  [it.item_id, (dailyBy.get(it.item_id) ?? []).filter((p) => p.d < todayKst && p.d < completeDay)]));
for (const it of items) {
  const d = dailyBy.get(it.item_id) ?? [];
  const complete = d.filter((x) => x.d < todayKst && x.d < completeDay);
  const tradesPerDay = it.span_days > 0.5 ? it.trades / it.span_days : it.trades * 2;
  const f = it.price_basis === 'trade' && tradesPerDay >= 5
    ? forecast(complete as Point[], market, 7, todayKst)
    : null;
  if (f) forecasts.set(it.item_id, f);
  writeFileSync(`${OUT}/data/series/${it.item_id}.json`, JSON.stringify({
    priceBasis: it.price_basis, daily: d, hourly: hourlyBy.get(it.item_id) ?? [],
    askGap: askGapBy.get(it.item_id) ?? [], depletion: depletionBy.get(it.item_id) ?? [],
    depth: depthBy.get(it.item_id) ?? [], events: eventsBy.get(it.item_id) ?? [], forecast: f,
    max: it.category === '카드' ? {
      priceBasis: 'askMax', daily: cardDailyMaxBy.get(it.item_id) ?? [],
      hourly: cardHourlyMaxBy.get(it.item_id) ?? [],
      depletion: cardDepletionMaxBy.get(it.item_id) ?? [],
    } : null,
  }));
}

// ── 패키지 해체 마진 ───────────────────────────────────────────
const PARTS = ['숲속의 유랑악단 아바타 풀세트 상자', '숲속의 유랑악단 크리쳐 상자',
  '숲속의 유랑악단 오라 상자', '숲속의 유랑악단 칭호 상자', '숲속의 유랑악단 세라 상자'];
const vw = (await query<{ item_name: string; vwap: number; n: number }>(`
  SELECT i.item_name, (SUM(t.unit_price::numeric*t.count)/SUM(t.count))::float8 vwap, COUNT(*)::int n
  FROM trades t JOIN items i USING (item_id)
  WHERE t.sold_date > now() - interval '24 hours'
    AND (i.item_name = ANY($1) OR i.item_name = '숲속의 유랑악단 패키지')
  GROUP BY 1`, [PARTS])).rows;
const pkg = vw.find((r) => r.item_name === '숲속의 유랑악단 패키지');
const parts = vw.filter((r) => r.item_name !== '숲속의 유랑악단 패키지');
const partsComplete = PARTS.every((name) => parts.some((part) => part.item_name === name));

// 패키지 출시·종료일과, 우리가 실제로 관측을 시작한 날.
// 출시일이 관측 시작보다 앞서면 t=0이 없어 출시 충격은 분석할 수 없다.
const packageEvent = (await query<{
  name: string; starts: string | null; ends: string | null; first_seen: string | null;
}>(`
  SELECT e.name,
         to_char(e.starts_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') starts,
         to_char(e.ends_at   AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') ends,
         (SELECT to_char(MIN(c.hour) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD')
            FROM candles_1h c JOIN items i USING (item_id)
           WHERE i.category = '유랑악단 패키지') first_seen
  FROM events e WHERE e.type = '패키지' ORDER BY e.starts_at DESC LIMIT 1`)).rows[0] ?? null;

// ── 레전더리 카드 최저가 지수 ──────────────────────────────────
const legendary = (await query<{
  captured_at: string; min_unit_price: number; min_item_name: string;
  p10: number; median: number; scanned: number; with_listings: number;
}>(`SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') captured_at,
      min_unit_price, min_item_name, p10, median, scanned, with_listings
    FROM legendary_card_floor WHERE upgrade = 0 ORDER BY captured_at DESC LIMIT 1`)).rows;

// ── 스태커블 시장 거래대금 순위 ──────────────────────────────
const marketRankingRows = (await query<{
  captured_at: string; rank: number; item_id: string; item_name: string;
  item_rarity: string; item_type_detail: string; turnover_24h: number;
  observed_qty: number; trade_count: number; last_price: number;
  basis: 'collected' | 'api_complete' | 'estimated'; span_minutes: number | null;
}>(`
  SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') captured_at,
         rank, item_id, item_name, item_rarity, item_type_detail,
         turnover_24h, observed_qty, trade_count, last_price, basis, span_minutes
  FROM market_rankings
  WHERE captured_at = (SELECT MAX(captured_at) FROM market_rankings)
  ORDER BY rank`)).rows;
const marketRanking = {
  capturedAt: marketRankingRows[0]?.captured_at ?? null,
  items: marketRankingRows.map((row) => ({
    ...row,
    img: `https://img-api.neople.co.kr/df/items/${row.item_id}`,
  })),
};

// ── 수집 현황 ──────────────────────────────────────────────────
// 원본 체결은 30일만 보존하므로, 누적 건수와 전체 기간은 영구 시간봉에서 읽는다.
const meta = (await query<{
  trades: number; items: number; lo: string; hi: string;
  depletion_qty: number;
}>(`
  SELECT (SELECT COALESCE(SUM(n), 0)::int FROM candles_1h) trades,
         (SELECT COUNT(*)::int FROM items WHERE tracked) items,
         (SELECT to_char(MIN(hour) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') FROM candles_1h) lo,
         (SELECT to_char(MAX(hour) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') FROM candles_1h) hi,
         (SELECT COALESCE(SUM(qty_sold),0)::int FROM listing_deltas
          WHERE reason <> 'expired' AND invalidated_at IS NULL
            AND observed_at > now() - interval '7 days') depletion_qty`)).rows[0];

const health = (await query<{
  checks24: number; global_uptime24: number | null;
  item_checks24: number; item_uptime24: number | null;
  stale_checks24: number; latest_stale_items: number | null;
}>(`
  SELECT COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours')::int AS checks24,
         (100.0 * COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours'
                                    AND gap_min <= 20)
           / NULLIF(COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours'), 0))::float8 AS global_uptime24,
         COUNT(stale_items) FILTER (WHERE checked_at > now() - interval '24 hours')::int AS item_checks24,
         (100.0 * (1 - SUM(stale_items) FILTER (WHERE checked_at > now() - interval '24 hours')::numeric
           / NULLIF(COUNT(stale_items) FILTER (WHERE checked_at > now() - interval '24 hours')
             * (SELECT COUNT(*) FROM items WHERE tracked), 0)))::float8 AS item_uptime24,
         COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours' AND stale_items > 0)::int AS stale_checks24,
         (SELECT stale_items FROM collection_health ORDER BY checked_at DESC LIMIT 1) AS latest_stale_items
  FROM collection_health`)).rows[0];

const withMeta = items.map((it) => {
  const f = forecasts.get(it.item_id);
  return {
    ...it,
    // 아이콘은 Neople이 공식 제공한다. 이미지를 굽지 않고 URL만 넘겨 CDN 캐시에 맡긴다.
    img: `https://img-api.neople.co.kr/df/items/${it.item_id}`,
    spark: (dailyBy.get(it.item_id) ?? []).slice(-14).map((d) => d.vwap),
    fc: f ? { next: f.points[0], vsNaive: f.vsNaive, coverage: f.coverage, backtest: f.backtest } : null,
  };
});

// ── 랜덤워크 검정 ──────────────────────────────────────────────
// 봉의 시각을 보존해야 공백을 1시간 수익률로 잘못 계산하지 않는다.
const rwRows = (await query<{
  item_id: string; t: string; vwap: number; n: number;
}>(`
  SELECT c.item_id, to_char(c.hour AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') t,
         c.vwap::float8 vwap, c.n
  FROM candles_1h c JOIN items i USING (item_id)
  WHERE i.tracked AND i.category <> '카드' AND c.vwap > 0
  ORDER BY c.item_id, c.hour`)).rows;

const rwBy = new Map<string, typeof rwRows>();
for (const row of rwRows) {
  if (!rwBy.has(row.item_id)) rwBy.set(row.item_id, []);
  rwBy.get(row.item_id)!.push(row);
}

const rwAsOf = Math.min(Date.now(), Date.parse(quality.through));
const rwCandidates = items.filter((it) => it.price_basis === 'trade');
const rwExcluded: Array<{ item_name: string; bars: number; reason: string }> = [];
const rwItems = rwCandidates.flatMap((it) => {
  const segment = longestCompleteHours(rwBy.get(it.item_id) ?? [], rwAsOf);
  const prices = segment.map((p) => p.vwap);
  const result = varianceRatio(prices);
  if (!result) {
    rwExcluded.push({ item_name: it.item_name, bars: segment.length,
      reason: segment.length < 30 ? '연속 관측 부족' : '수익률 분산 또는 표준오차 추정 불가' });
    return [];
  }
  const logReturns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = logReturns.reduce((sum, x) => sum + x, 0) / logReturns.length;
  const volatility = Math.sqrt(logReturns.reduce((sum, x) => sum + (x - mean) ** 2, 0)
    / (logReturns.length - 1)) * 100;
  return [{
    item_id: it.item_id, item_name: it.item_name, category: it.category,
    bars: segment.length, from: segment[0].t, to: segment.at(-1)!.t,
    per_bar: segment.reduce((sum, p) => sum + p.n, 0) / segment.length,
    price: prices.reduce((sum, p) => sum + p, 0) / prices.length, volatility,
    ...result, adjustedP: 1, significant: false,
  }];
}).sort((a, b) => a.vr - b.vr);
const adjusted = holmAdjusted(rwItems.map((it) => it.p));
rwItems.forEach((it, i) => {
  it.adjustedP = adjusted[i];
  it.significant = it.adjustedP < 0.05;
});

const byThickness = [...rwItems].sort((a, b) => a.per_bar - b.per_bar);
const third = Math.ceil(byThickness.length / 3) || 1;
const thickness = [
  ['얇음', byThickness.slice(0, third)],
  ['중간', byThickness.slice(third, third * 2)],
  ['두꺼움', byThickness.slice(third * 2)],
] as const;
const vrSorted = rwItems.map((x) => x.vr).sort((a, b) => a - b);

const randomWalk = {
  q: 2, minBars: 30, asOf: new Date(rwAsOf).toISOString(),
  candidates: rwCandidates.length, excluded: rwExcluded,
  items: rwItems,
  total: rwItems.length,
  significant: rwItems.filter((x) => x.significant).length,
  negative: rwItems.filter((x) => x.significant && x.vr < 1).length,
  positive: rwItems.filter((x) => x.significant && x.vr > 1).length,
  medianVr: vrSorted.length
    ? (vrSorted[Math.floor((vrSorted.length - 1) / 2)] + vrSorted[Math.floor(vrSorted.length / 2)]) / 2 : null,
  // 종목별 거래 빈도 비교는 관측 잡음을 배제하는 검정이 아닌 보조 설명이다.
  thickness: thickness.filter(([, g]) => g.length).map(([label, group]) => ({
    label,
    items: group.length,
    perBar: group.reduce((a, x) => a + x.per_bar, 0) / group.length,
    vr: group.reduce((a, x) => a + x.vr, 0) / group.length,
  })),
};

writeFileSync(`${OUT}/data/summary.json`, JSON.stringify({
  builtAt: new Date().toISOString(),
  priceAsOf: quality.checkedAt,
  meta, health, quality, collection, weekday, weekdaySample, randomWalk, items: withMeta, legendary, marketRanking,
  margin: {
    pkg: pkg?.vwap ?? null, pkgN: pkg?.n ?? 0, parts, partsComplete,
    partsSum: parts.reduce((s, r) => s + r.vwap, 0), fee: 0.03,
    event: packageEvent,
  },
}));

for (const f of ['index.html', 'ranking.html', 'analysis.html', 'guide.html', 'app.js', 'metrics.js', 'ranking.js', 'style.css']) copyFileSync(`web/${f}`, `${OUT}/${f}`);
writeFileSync(`${OUT}/.nojekyll`, '');

console.log(`빌드 완료 — ${items.length}종 · 체결 ${meta.trades.toLocaleString()}건 · 일봉 ${daily.length}행 · 예측 ${forecasts.size}종`);
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
