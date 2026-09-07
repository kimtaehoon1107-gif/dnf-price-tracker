// Supabase를 읽어 정적 사이트를 굽는다.
//
// 서버를 두지 않는 이유: 조회 트래픽이 사실상 없는데 상시 서버를 굴릴 이유가 없고,
// 수집 Actions가 10분마다 어차피 돌기 때문에 그때 같이 구우면 갱신 주기가 같아진다.
// 결과적으로 서버 0대, 비용 0원, 첫 로딩은 정적 파일 속도가 된다.
//
//   node --env-file=.env --no-warnings web/build.ts

import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { query, pool } from '../src/db.ts';

const OUT = 'dist';
mkdirSync(`${OUT}/data/series`, { recursive: true });

// ── 아이템 요약 ────────────────────────────────────────────────
const items = (await query<{
  item_id: string; item_name: string; item_rarity: string; item_type_detail: string;
  role: string; trades: number; span_days: number; last_price: number;
  vwap24: number | null; vwap_prev: number | null; qty24: number; listings: number; min_ask: number | null;
}>(`
  WITH agg AS (
    SELECT item_id,
           COUNT(*)::int AS trades,
           (EXTRACT(EPOCH FROM MAX(sold_date)-MIN(sold_date))/86400)::float8 AS span_days,
           (SUM(unit_price::numeric*count) FILTER (WHERE sold_date > now()-interval '24 hours')
             / NULLIF(SUM(count) FILTER (WHERE sold_date > now()-interval '24 hours'),0))::float8 AS vwap24,
           (SUM(unit_price::numeric*count) FILTER (WHERE sold_date BETWEEN now()-interval '48 hours' AND now()-interval '24 hours')
             / NULLIF(SUM(count) FILTER (WHERE sold_date BETWEEN now()-interval '48 hours' AND now()-interval '24 hours'),0))::float8 AS vwap_prev,
           COALESCE(SUM(count) FILTER (WHERE sold_date > now()-interval '24 hours'),0)::int AS qty24
    FROM trades GROUP BY item_id
  ),
  last_snap AS (
    SELECT DISTINCT ON (item_id) item_id, listing_count, min_unit_price
    FROM listing_snapshots ORDER BY item_id, captured_at DESC
  ),
  last_trade AS (
    SELECT DISTINCT ON (item_id) item_id, unit_price FROM trades ORDER BY item_id, sold_date DESC
  )
  SELECT i.item_id, i.item_name, i.item_rarity, i.item_type_detail, i.role,
         COALESCE(a.trades,0) AS trades, COALESCE(a.span_days,0) AS span_days,
         COALESCE(lt.unit_price,0)::float8 AS last_price,
         a.vwap24, a.vwap_prev, COALESCE(a.qty24,0) AS qty24,
         COALESCE(ls.listing_count,0) AS listings, ls.min_unit_price::float8 AS min_ask
  FROM items i
  LEFT JOIN agg a USING (item_id)
  LEFT JOIN last_snap ls USING (item_id)
  LEFT JOIN last_trade lt USING (item_id)
  WHERE i.tracked ORDER BY i.item_name`)).rows;

// ── 아이템별 일봉 ──────────────────────────────────────────────
const daily = (await query<{
  item_id: string; d: string; o: number; h: number; l: number; c: number; vwap: number; qty: number; n: number;
}>(`
  SELECT item_id,
         to_char((sold_date AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS d,
         (array_agg(unit_price ORDER BY sold_date))[1]::float8 AS o,
         MAX(unit_price)::float8 AS h, MIN(unit_price)::float8 AS l,
         (array_agg(unit_price ORDER BY sold_date DESC))[1]::float8 AS c,
         (SUM(unit_price::numeric*count)/SUM(count))::float8 AS vwap,
         SUM(count)::int AS qty, COUNT(*)::int AS n
  FROM trades GROUP BY 1,2 ORDER BY 1,2`)).rows;

// ── 시간봉 (최근 7일) ──────────────────────────────────────────
const hourly = (await query<{ item_id: string; t: string; vwap: number; qty: number }>(`
  SELECT item_id,
         to_char(date_trunc('hour', sold_date),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
         (SUM(unit_price::numeric*count)/SUM(count))::float8 AS vwap, SUM(count)::int AS qty
  FROM trades WHERE sold_date > now() - interval '7 days'
  GROUP BY 1,2 ORDER BY 1,2`)).rows;

// 목록을 한 덩어리로 늘어놓으면 80종이 그냥 벽이 된다. 성격이 다른 것들을
// 묶어줘야 "이 시장이 무엇으로 이루어져 있는지"가 보인다.
function category(name: string, typeDetail: string): string {
  if (/증폭권|강화권|증폭 보호권/.test(name)) return '강화·증폭';
  if (/^숲속의 유랑악단/.test(name)) return '유랑악단 패키지';
  if (/소울 결정/.test(name)) return '소울 결정';
  if (/카드$/.test(name)) return '카드';
  if (/보주$/.test(name)) return '보주';
  if (/상자|주머니|큐브/.test(name)) return '상자·큐브';
  if (typeDetail === '크리쳐' || /알$/.test(name)) return '크리쳐';
  return '재료·소모품';
}

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

for (const it of items) {
  writeFileSync(`${OUT}/data/series/${it.item_id}.json`, JSON.stringify({
    daily: dailyBy.get(it.item_id) ?? [],
    hourly: hourlyBy.get(it.item_id) ?? [],
  }));
}

// ── 요일 효과 ──────────────────────────────────────────────────
const weekday = (await query<{ dow: string; k: number; n: number; ret: number; se: number; vol: number }>(`
  WITH span AS (SELECT item_id FROM trades GROUP BY item_id
    HAVING MAX(sold_date)-MIN(sold_date) > interval '14 days' AND COUNT(*)>=25),
  daily AS (SELECT t.item_id,(t.sold_date AT TIME ZONE 'Asia/Seoul')::date d,
    SUM(t.unit_price::numeric*t.count)/SUM(t.count) vwap, SUM(t.count)::int qty
    FROM trades t JOIN span s USING (item_id) GROUP BY 1,2),
  base AS (SELECT item_id, AVG(vwap) m, AVG(qty) mq FROM daily GROUP BY 1),
  norm AS (SELECT d.d, LN(d.vwap/b.m) lr, d.qty/NULLIF(b.mq,0) rq
    FROM daily d JOIN base b USING (item_id) WHERE b.m>0 AND d.vwap>0)
  SELECT to_char(d,'Dy') dow, EXTRACT(isodow FROM d)::int k, COUNT(*)::int n,
    (AVG(lr)*100)::float8 ret, (STDDEV(lr)/SQRT(COUNT(*))*100)::float8 se, AVG(rq)::float8 vol
  FROM norm GROUP BY 1,2 ORDER BY 2`)).rows;

// ── 패키지 해체 마진 ───────────────────────────────────────────
const PARTS = ['숲속의 유랑악단 아바타 풀세트 상자', '숲속의 유랑악단 크리쳐 상자',
  '숲속의 유랑악단 오라 상자', '숲속의 유랑악단 칭호 상자', '숲속의 유랑악단 세라 상자'];
const vw = (await query<{ item_name: string; vwap: number; n: number }>(`
  SELECT i.item_name, (SUM(t.unit_price::numeric*t.count)/SUM(t.count))::float8 vwap, COUNT(*)::int n
  FROM trades t JOIN items i USING (item_id)
  WHERE i.item_name = ANY($1) OR i.item_name = '숲속의 유랑악단 패키지'
  GROUP BY 1`, [PARTS])).rows;
const pkg = vw.find((r) => r.item_name === '숲속의 유랑악단 패키지');
const parts = vw.filter((r) => r.item_name !== '숲속의 유랑악단 패키지');
const partsSum = parts.reduce((s, r) => s + r.vwap, 0);

// ── 수집 현황 ──────────────────────────────────────────────────
const meta = (await query<{ trades: number; items: number; lo: string; hi: string; runs: number; errors: number; qty: number }>(`
  SELECT (SELECT COUNT(*)::int FROM trades) trades,
         (SELECT COUNT(*)::int FROM items WHERE tracked) items,
         (SELECT to_char(MIN(sold_date),'YYYY-MM-DD') FROM trades) lo,
         (SELECT to_char(MAX(sold_date),'YYYY-MM-DD') FROM trades) hi,
         (SELECT COUNT(*)::int FROM collection_runs) runs,
         (SELECT COUNT(error)::int FROM collection_runs) errors,
         (SELECT COALESCE(SUM(qty_sold),0)::int FROM listing_deltas WHERE reason <> 'expired') qty`)).rows[0];

// 아이템 아이콘은 Neople이 공식 제공한다 (img-api.neople.co.kr/df/items/{itemId}).
// 이미지를 직접 받아 두지 않고 URL만 넘긴다 — 재배포 때마다 80장을 굽는 것보다
// 브라우저가 CDN에서 캐시하게 두는 편이 빠르고, 아이콘이 바뀌면 자동으로 따라간다.
const withMeta = items.map((it) => ({
  ...it,
  img: `https://img-api.neople.co.kr/df/items/${it.item_id}`,
  cat: category(it.item_name, it.item_type_detail),
}));

writeFileSync(`${OUT}/data/summary.json`, JSON.stringify({
  builtAt: new Date().toISOString(),
  meta, weekday, items: withMeta,
  margin: { pkg: pkg?.vwap ?? null, pkgN: pkg?.n ?? 0, parts, partsSum, fee: 0.03 },
}));

for (const f of ['index.html', 'analysis.html', 'app.js', 'style.css']) {
  copyFileSync(`web/${f}`, `${OUT}/${f}`);
}
writeFileSync(`${OUT}/.nojekyll`, '');

console.log(`빌드 완료 — 아이템 ${items.length}종 · 체결 ${meta.trades.toLocaleString()}건 · 일봉 ${daily.length}행`);
await pool.end();
