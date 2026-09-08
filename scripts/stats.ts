// 수집 현황 점검. "데이터에 구멍이 없는가"를 확인하는 용도.

import { query, pool } from '../src/db.ts';

const { rows } = await query<{
  item_name: string; poll_interval_sec: number; n: number;
  span_min: number | null; max_gap_min: number | null; qty: number; sat: number;
}>(`
  WITH gaps AS (
    SELECT item_id,
           COUNT(*)::int AS n,
           -- numeric으로 두면 pg가 문자열로 넘겨준다. float8로 캐스팅해야 숫자로 받는다.
           (EXTRACT(EPOCH FROM MAX(sold_date) - MIN(sold_date)) / 60)::float8 AS span_min,
           (MAX(EXTRACT(EPOCH FROM sold_date - prev)) / 60)::float8 AS max_gap_min
    FROM (SELECT item_id, sold_date, LAG(sold_date) OVER (PARTITION BY item_id ORDER BY sold_date) AS prev
          FROM trades) t
    GROUP BY item_id
  )
  SELECT i.item_name, i.poll_interval_sec,
         COALESCE(g.n, 0) AS n, g.span_min, g.max_gap_min,
         COALESCE((SELECT SUM(qty_sold) FROM listing_deltas d
                   WHERE d.item_id = i.item_id AND d.reason <> 'expired'
                     AND d.invalidated_at IS NULL), 0)::int AS qty,
         COALESCE((SELECT COUNT(*) FROM collection_runs r
                   WHERE r.item_id = i.item_id AND r.saturated), 0)::int AS sat
  FROM items i LEFT JOIN gaps g ON g.item_id = i.item_id
  WHERE i.tracked
  ORDER BY i.poll_interval_sec, i.item_name`);

const dur = (m: number | null) => m === null ? '-'
  : m >= 1440 ? `${(m / 1440).toFixed(1)}일` : m >= 60 ? `${(m / 60).toFixed(1)}시간` : `${m.toFixed(0)}분`;
const pad = (s: string, n: number) => s.length > n ? s.slice(0, n) : s.padEnd(n);

console.log(pad('아이템', 24) + '주기'.padStart(7) + '체결'.padStart(8) + '수집기간'.padStart(11) +
  '최대공백'.padStart(11) + '소진관측'.padStart(11) + '포화'.padStart(6));
console.log('─'.repeat(78));

for (const r of rows) {
  console.log(
    pad(r.item_name, 24) +
    `${r.poll_interval_sec}s`.padStart(7) +
    String(r.n).padStart(8) +
    dur(r.span_min).padStart(12) +
    dur(r.max_gap_min).padStart(12) +
    `${r.qty.toLocaleString()}개`.padStart(12) +
    (r.sat > 0 ? `⚠${r.sat}` : '·').padStart(6));
}

const t = await query<{ n: number; lo: Date | null; hi: Date | null }>(
  'SELECT COUNT(*)::int AS n, MIN(sold_date) AS lo, MAX(sold_date) AS hi FROM trades');
const c = await query<{ n: number; e: number; last: Date | null }>(`
  SELECT COUNT(*)::int AS n, COUNT(error)::int AS e,
         MAX(finished_at) FILTER (WHERE error IS NULL) AS last
  FROM collection_runs`);
const sources = (await query<{ source: string; n: number }>(`
  SELECT COALESCE(source, '미기록') AS source, COUNT(*)::int AS n
  FROM collection_runs GROUP BY 1 ORDER BY n DESC`)).rows;

console.log('─'.repeat(78));
console.log(`체결 ${t.rows[0].n.toLocaleString()}건 · 수집 실행 ${c.rows[0].n}회 (실패 ${c.rows[0].e})`);
if (t.rows[0].lo) {
  console.log(`데이터 구간  ${t.rows[0].lo.toISOString().slice(0, 19)} ~ ${t.rows[0].hi!.toISOString().slice(0, 19)} UTC`);
}
if (c.rows[0].last) {
  const ago = (Date.now() - c.rows[0].last.getTime()) / 60_000;
  console.log(`마지막 수집  ${ago < 60 ? `${ago.toFixed(0)}분 전` : `${(ago / 60).toFixed(1)}시간 전`}` +
    (ago > 10 ? '  ⚠ 10분 이상 수집되지 않았습니다' : ''));
}
console.log(`수집 출처    ${sources.map((x) => `${x.source} ${x.n}회`).join(' · ')}`);

console.log('\n"최대공백"은 실제 무거래뿐 아니라 수집 공백 때문에 커질 수도 있습니다.');
console.log('"포화"는 100건 응답이 이전 수집과 겹치지 않아 초과 거래를 놓쳤을 가능성이 있다는 뜻입니다.');

await pool.end();
