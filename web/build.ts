// Supabase를 읽어 정적 사이트를 굽는다.
//
// 서버를 두지 않는 이유: 조회 트래픽이 사실상 없는데 상시 서버를 굴릴 이유가 없고,
// 수집 Actions가 어차피 돌기 때문에 그때 같이 구우면 갱신 주기가 같아진다.
// 결과적으로 서버 0대, 비용 0원, 첫 로딩은 정적 파일 속도가 된다.
//
//   node --env-file=.env --no-warnings web/build.ts

import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { query, pool } from '../src/db.ts';
import { forecast, type Point, type Forecast } from '../src/forecast.ts';

const OUT = 'dist';
mkdirSync(`${OUT}/data/series`, { recursive: true });

// ── 아이템 요약 ────────────────────────────────────────────────
const items = (await query<{
  item_id: string; item_name: string; item_rarity: string; item_type_detail: string;
  role: string; category: string; slot: string | null; job_role: string | null;
  is_final: boolean; final_since: string | null; key_stat: string | null;
  price_basis: 'trade' | 'ask0';
  trades: number; span_days: number; last_price: number;
  vwap24: number | null; vwap_prev: number | null; api_qty24: number;
  listings: number; min_ask: number | null; median_ask: number | null;
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
    WHERE i.category = '카드' AND s.upgrade = 0 AND s.min_unit_price > 0
    GROUP BY s.item_id
  ),
  agg AS (
    SELECT * FROM trade_agg UNION ALL SELECT * FROM card_agg
  ),
  last_snap AS (
    SELECT DISTINCT ON (s.item_id) s.item_id, s.listing_count, s.min_unit_price, s.median
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE i.category <> '카드' OR s.upgrade = 0
    ORDER BY s.item_id, s.captured_at DESC
  ),
  last_trade AS (
    SELECT DISTINCT ON (t.item_id) t.item_id, t.unit_price
    FROM trades t JOIN items i USING (item_id)
    WHERE i.category <> '카드'
    ORDER BY t.item_id, t.sold_date DESC, t.id DESC
  )
  SELECT i.item_id, i.item_name, i.item_rarity, i.item_type_detail, i.role,
         COALESCE(i.category,'기타') AS category, i.slot, i.job_role,
         i.is_final, to_char(i.final_since,'YYYY-MM-DD') AS final_since, i.key_stat,
         CASE WHEN i.category = '카드' THEN 'ask0' ELSE 'trade' END AS price_basis,
         COALESCE(a.trades,0) AS trades, COALESCE(a.span_days,0) AS span_days,
         COALESCE(CASE WHEN i.category = '카드' THEN ls.min_unit_price ELSE lt.unit_price END,0)::float8 AS last_price,
         a.vwap24, a.vwap_prev, COALESCE(a.api_qty24,0) AS api_qty24,
         COALESCE(ls.listing_count,0) AS listings,
         ls.min_unit_price::float8 AS min_ask, ls.median::float8 AS median_ask
  FROM items i
  LEFT JOIN agg a USING (item_id)
  LEFT JOIN last_snap ls USING (item_id)
  LEFT JOIN last_trade lt USING (item_id)
  WHERE i.tracked ORDER BY i.item_name`)).rows;

// ── 아이템별 일봉 / 시간봉 ─────────────────────────────────────
const daily = (await query<{
  item_id: string; d: string; o: number; h: number; l: number; c: number; vwap: number; qty: number; n: number;
}>(`
  WITH trade_daily AS (
    SELECT t.item_id,
         to_char((sold_date AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS d,
         (array_agg(unit_price ORDER BY sold_date, id))[1]::float8 AS o,
         MAX(unit_price)::float8 AS h, MIN(unit_price)::float8 AS l,
         (array_agg(unit_price ORDER BY sold_date DESC, id DESC))[1]::float8 AS c,
         (SUM(unit_price::numeric*count)/SUM(count))::float8 AS vwap,
         SUM(count)::int AS qty, COUNT(*)::int AS n
    FROM trades t JOIN items i USING (item_id)
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
    WHERE i.category = '카드' AND s.upgrade = 0 AND s.min_unit_price > 0
    GROUP BY 1,2
  )
  SELECT * FROM trade_daily UNION ALL SELECT * FROM card_daily ORDER BY 1,2`)).rows;

const hourly = (await query<{ item_id: string; t: string; vwap: number; qty: number }>(`
  WITH trade_hourly AS (
    SELECT t.item_id,
         to_char(date_trunc('hour', sold_date AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
         (SUM(unit_price::numeric*count)/SUM(count))::float8 AS vwap, SUM(count)::int AS qty
    FROM trades t JOIN items i USING (item_id)
    WHERE sold_date > now() - interval '7 days' AND i.category <> '카드'
    GROUP BY 1,2
  ), card_hourly AS (
    SELECT s.item_id,
           to_char(date_trunc('hour', s.captured_at AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
           AVG(s.min_unit_price)::float8 AS vwap, 0::int AS qty
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE s.captured_at > now() - interval '7 days'
      AND i.category = '카드' AND s.upgrade = 0 AND s.min_unit_price > 0
    GROUP BY 1,2
  )
  SELECT * FROM trade_hourly UNION ALL SELECT * FROM card_hourly ORDER BY 1,2`)).rows;

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
  item_id: string; t: string; qty: number; partial: number; vanished: number;
  observed_min: number; rate: number;
}>(`
  WITH observations AS (
    SELECT s.item_id, captured_at,
           LAG(captured_at) OVER (PARTITION BY item_id ORDER BY captured_at) AS prev_at
    FROM listing_snapshots s JOIN items i USING (item_id)
    WHERE captured_at > now() - interval '8 days'
      AND (i.category <> '카드' OR s.upgrade = 0)
  ), deltas AS (
    SELECT d.item_id, observed_at,
           COALESCE(SUM(qty_sold) FILTER (WHERE reason = 'partial'), 0)::float8 AS partial,
           COALESCE(SUM(qty_sold) FILTER (WHERE reason = 'vanished_before_expiry'), 0)::float8 AS vanished
    FROM listing_deltas d JOIN items i USING (item_id)
    JOIN listings l ON l.auction_no = d.auction_no
    WHERE observed_at > now() - interval '7 days'
      AND (i.category <> '카드' OR l.upgrade = 0)
    GROUP BY d.item_id, observed_at
  )
  SELECT o.item_id,
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
  WHERE o.captured_at > now() - interval '7 days' AND o.prev_at IS NOT NULL
  GROUP BY o.item_id, date_trunc('hour', o.captured_at AT TIME ZONE 'UTC')
  ORDER BY o.item_id, 2`)).rows;

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
const askGapBy = byItem(askGap);
const depletionBy = byItem(depletion);
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
const weekday = (await query<{ dow: string; k: number; n: number; ret: number; se: number; vol: number }>(`
  WITH span AS (SELECT t.item_id FROM trades t JOIN items i USING (item_id)
    WHERE i.category <> '카드' GROUP BY t.item_id
    HAVING MAX(sold_date)-MIN(sold_date) > interval '14 days' AND COUNT(*)>=25),
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
  FROM norm GROUP BY 1,2 ORDER BY 2`)).rows;

// 예측에 쓸 공통 요일 계수 (주간 평균을 0으로 맞춘 로그 편차).
// 아이템 하나하나는 표본이 얇아 자기 요일 효과를 못 추정하므로 전체에서 빌려 쓴다.
const wkMean = weekday.reduce((a, x) => a + x.ret, 0) / (weekday.length || 1);
const dowCoef = new Map(weekday.map((w) => [w.k, (w.ret - wkMean) / 100]));

// ── 아이템별 시계열 + 예측 ─────────────────────────────────────
const forecasts = new Map<string, Forecast>();
const todayKst = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
for (const it of items) {
  const d = dailyBy.get(it.item_id) ?? [];
  const complete = d.filter((x) => x.d < todayKst);
  const tradesPerDay = it.span_days > 0.5 ? it.trades / it.span_days : it.trades * 2;
  const f = it.price_basis === 'trade' && tradesPerDay >= 5
    ? forecast(complete.map((x) => ({ d: x.d, vwap: x.vwap })) as Point[], dowCoef, 7, todayKst)
    : null;
  if (f) forecasts.set(it.item_id, f);
  writeFileSync(`${OUT}/data/series/${it.item_id}.json`, JSON.stringify({
    priceBasis: it.price_basis, daily: d, hourly: hourlyBy.get(it.item_id) ?? [],
    askGap: askGapBy.get(it.item_id) ?? [], depletion: depletionBy.get(it.item_id) ?? [],
    depth: depthBy.get(it.item_id) ?? [], events: eventsBy.get(it.item_id) ?? [], forecast: f,
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

// ── 레전더리 카드 최저가 지수 ──────────────────────────────────
const legendary = (await query<{
  captured_at: string; min_unit_price: number; min_item_name: string;
  p10: number; median: number; scanned: number; with_listings: number;
}>(`SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') captured_at,
      min_unit_price, min_item_name, p10, median, scanned, with_listings
    FROM legendary_card_floor WHERE upgrade = 0 ORDER BY captured_at DESC LIMIT 200`)).rows;

// ── 수집 현황 ──────────────────────────────────────────────────
const meta = (await query<{
  trades: number; items: number; lo: string; hi: string; runs: number; errors: number;
  depletion_qty: number;
}>(`
  SELECT (SELECT COUNT(*)::int FROM trades) trades,
         (SELECT COUNT(*)::int FROM items WHERE tracked) items,
         (SELECT to_char(MIN(sold_date) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') FROM trades) lo,
         (SELECT to_char(MAX(sold_date) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') FROM trades) hi,
         (SELECT COUNT(*)::int FROM collection_runs) runs,
         (SELECT COUNT(error)::int FROM collection_runs) errors,
         (SELECT COALESCE(SUM(qty_sold),0)::int FROM listing_deltas
          WHERE reason <> 'expired') depletion_qty`)).rows[0];

const health = (await query<{
  checks24: number; uptime24: number | null;
  before_checks: number; uptime_before: number | null;
  after_checks: number; uptime_after: number | null;
}>(`
  SELECT COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours')::int AS checks24,
         (100.0 * COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours' AND action = 'ok')
           / NULLIF(COUNT(*) FILTER (WHERE checked_at > now() - interval '24 hours'), 0))::float8 AS uptime24,
         COUNT(*) FILTER (WHERE checked_at < timestamptz '2026-09-07 15:15:00+00')::int AS before_checks,
         (100.0 * COUNT(*) FILTER (WHERE checked_at < timestamptz '2026-09-07 15:15:00+00' AND action = 'ok')
           / NULLIF(COUNT(*) FILTER (WHERE checked_at < timestamptz '2026-09-07 15:15:00+00'), 0))::float8 AS uptime_before,
         COUNT(*) FILTER (WHERE checked_at >= timestamptz '2026-09-07 15:15:00+00')::int AS after_checks,
         (100.0 * COUNT(*) FILTER (WHERE checked_at >= timestamptz '2026-09-07 15:15:00+00' AND action = 'ok')
           / NULLIF(COUNT(*) FILTER (WHERE checked_at >= timestamptz '2026-09-07 15:15:00+00'), 0))::float8 AS uptime_after
  FROM collection_health`)).rows[0];

const withMeta = items.map((it) => {
  const f = forecasts.get(it.item_id);
  return {
    ...it,
    // 아이콘은 Neople이 공식 제공한다. 이미지를 굽지 않고 URL만 넘겨 CDN 캐시에 맡긴다.
    img: `https://img-api.neople.co.kr/df/items/${it.item_id}`,
    spark: (dailyBy.get(it.item_id) ?? []).slice(-14).map((d) => d.vwap),
    fc: f ? { next: f.points[0], vsNaive: f.vsNaive, coverage: f.coverage } : null,
  };
});

writeFileSync(`${OUT}/data/summary.json`, JSON.stringify({
  builtAt: new Date().toISOString(),
  meta, health, weekday, items: withMeta, legendary,
  margin: {
    pkg: pkg?.vwap ?? null, pkgN: pkg?.n ?? 0, parts, partsComplete,
    partsSum: parts.reduce((s, r) => s + r.vwap, 0), fee: 0.03,
  },
}));

for (const f of ['index.html', 'analysis.html', 'app.js', 'style.css']) copyFileSync(`web/${f}`, `${OUT}/${f}`);
writeFileSync(`${OUT}/.nojekyll`, '');

console.log(`빌드 완료 — ${items.length}종 · 체결 ${meta.trades.toLocaleString()}건 · 일봉 ${daily.length}행 · 예측 ${forecasts.size}종`);
await pool.end();
