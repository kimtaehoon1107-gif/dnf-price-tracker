// 수집 현황 점검. "데이터에 구멍이 없는가"를 확인하는 용도.

import { db } from '../src/db.ts';

const items = db.prepare(
  'SELECT item_id, item_name, poll_interval_sec FROM items WHERE tracked = 1 ORDER BY poll_interval_sec'
).all() as Array<{ item_id: string; item_name: string; poll_interval_sec: number }>;

const fmtDur = (min: number) =>
  min >= 1440 ? `${(min / 1440).toFixed(1)}일` : min >= 60 ? `${(min / 60).toFixed(1)}시간` : `${min.toFixed(0)}분`;

console.log('아이템'.padEnd(22) + '체결'.padStart(7) + '수집기간'.padStart(11) +
  '최대공백'.padStart(11) + '소진관측'.padStart(10) + '포화'.padStart(6));
console.log('─'.repeat(70));

let totalTrades = 0;
for (const it of items) {
  const times = (db.prepare(
    'SELECT sold_date FROM trades WHERE item_id = ? ORDER BY sold_date'
  ).all(it.item_id) as Array<{ sold_date: string }>).map((r) => Date.parse(r.sold_date));

  const qty = (db.prepare(
    "SELECT COALESCE(SUM(qty_sold), 0) AS q FROM listing_deltas WHERE item_id = ? AND reason != 'expired'"
  ).get(it.item_id) as { q: number }).q;

  const sat = (db.prepare(
    'SELECT COUNT(*) AS n FROM collection_runs WHERE item_id = ? AND saturated = 1'
  ).get(it.item_id) as { n: number }).n;

  totalTrades += times.length;

  let spanMin = 0;
  let maxGapMin = 0;
  if (times.length > 1) {
    spanMin = (times.at(-1)! - times[0]) / 60_000;
    for (let i = 1; i < times.length; i++) {
      maxGapMin = Math.max(maxGapMin, (times[i] - times[i - 1]) / 60_000);
    }
  }

  console.log(
    it.item_name.padEnd(20) +
    String(times.length).padStart(7) +
    (times.length > 1 ? fmtDur(spanMin) : '-').padStart(12) +
    (times.length > 1 ? fmtDur(maxGapMin) : '-').padStart(12) +
    `${qty}개`.padStart(11) +
    (sat > 0 ? `⚠${sat}` : '·').padStart(6));
}

const runs = db.prepare(
  'SELECT COUNT(*) AS n, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS e FROM collection_runs'
).get() as { n: number; e: number };

console.log('─'.repeat(70));
console.log(`체결 ${totalTrades.toLocaleString()}건 · 수집 실행 ${runs.n}회 (실패 ${runs.e ?? 0})`);
console.log('\n"최대공백"이 그 아이템의 폴링 주기보다 훨씬 크면 실제로 거래가 없던 구간이고,');
console.log('"포화"에 표시가 뜨면 100건 상한에 걸려 거래를 놓쳤다는 뜻이므로 주기를 줄여야 합니다.');
