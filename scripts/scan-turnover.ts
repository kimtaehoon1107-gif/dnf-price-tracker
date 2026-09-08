// 카탈로그의 옵션 없는 경매장 품목을 훑어 24시간 거래대금 후보를 찾는다.
//
// 최근 100건이 24시간을 다 덮지 못하면 정확한 합계를 알 수 없다. 그 경우에는
// 100건의 체결 속도를 24시간으로 환산한 탐색용 추정치만 만들고 반드시 표시한다.

import { readFileSync } from 'node:fs';
import { getSold, kstToIso, type ItemRow } from '../src/api.ts';
import { pool, query, tx } from '../src/db.ts';

const CATALOG = JSON.parse(readFileSync(new URL('../data/market-items.json', import.meta.url), 'utf8')) as ItemRow[];
const CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const cutoff = now - DAY_MS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RankRow {
  itemId: string;
  itemName: string;
  itemRarity: string;
  itemTypeDetail: string;
  turnover24: number;
  observedQty: number;
  trades: number;
  lastPrice: number;
  spanMinutes: number | null;
  basis: 'collected' | 'api_complete' | 'estimated';
}

async function inspect(row: ItemRow): Promise<RankRow | null> {
  let sold;
  for (let attempt = 0; ; attempt++) {
    try {
      sold = await getSold(row.itemId, 100);
      break;
    } catch (error) {
      if (attempt === 3 || !String(error).includes('APIKEY_LIMIT')) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
  if (!sold.length) return null;

  const dated = sold.map((trade) => ({ trade, time: Date.parse(kstToIso(trade.soldDate)) }))
    .filter((x) => Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time);
  if (!dated.length) return null;

  const recent = dated.filter((x) => x.time >= cutoff);
  const observedGold = recent.reduce((sum, x) => sum + x.trade.unitPrice * x.trade.count, 0);
  const observedQty = recent.reduce((sum, x) => sum + x.trade.count, 0);
  const saturated = dated.length === 100 && dated[0].time > cutoff;

  let turnover24 = observedGold;
  let spanMinutes: number | null = null;
  if (saturated) {
    // 100개 표본의 양 끝만 빼면 99개 간격이므로 평균 간격 하나를 더해 관측창을 근사한다.
    const rawSpan = dated.at(-1)!.time - dated[0].time;
    const coveredMs = Math.max(60_000, rawSpan * dated.length / (dated.length - 1));
    spanMinutes = coveredMs / 60_000;
    turnover24 = observedGold * DAY_MS / coveredMs;
  }

  return {
    itemId: row.itemId,
    itemName: row.itemName,
    itemRarity: row.itemRarity,
    itemTypeDetail: row.itemTypeDetail,
    turnover24: Math.round(turnover24),
    observedQty,
    trades: recent.length,
    lastPrice: dated.at(-1)!.trade.unitPrice,
    spanMinutes,
    basis: saturated ? 'estimated' : 'api_complete',
  };
}

const force = process.argv.includes('--force');
const latest = (await query<{ captured_at: Date | null }>(
  'SELECT MAX(captured_at) captured_at FROM market_rankings',
)).rows[0]?.captured_at;
if (!force && latest && now - new Date(latest).getTime() < 23 * 60 * 60 * 1000) {
  console.log(`최근 순위가 있어 건너뜁니다 — ${new Date(latest).toISOString()}`);
  await pool.end();
  process.exit(0);
}

const candidates = CATALOG;
const rows: RankRow[] = [];
let cursor = 0;
let failures = 0;

async function worker() {
  while (cursor < candidates.length) {
    const index = cursor++;
    try {
      const result = await inspect(candidates[index]);
      if (result) rows.push(result);
    } catch {
      failures++;
    }
    await sleep(75);
    if ((index + 1) % 500 === 0) console.error(`${index + 1}/${candidates.length}`);
  }
}

console.error(`후보 ${candidates.length.toLocaleString()}종의 최근 체결을 조회합니다…`);
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// 계속 수집 중인 품목은 짧은 표본을 24시간으로 환산하지 않고 DB 관측 합계를 쓴다.
const collected = (await query<{
  item_id: string; item_name: string; item_rarity: string; item_type_detail: string;
  turnover_24h: number; observed_qty: number; trade_count: number; last_price: number;
}>(`
  SELECT i.item_id, i.item_name, i.item_rarity, i.item_type_detail,
         SUM(t.unit_price::numeric*t.count)::float8 turnover_24h,
         SUM(t.count)::int observed_qty, COUNT(*)::int trade_count,
         (array_agg(t.unit_price ORDER BY t.sold_date DESC, t.id DESC))[1]::float8 last_price
  FROM trades t JOIN items i USING (item_id)
  WHERE i.tracked AND i.category <> '카드' AND t.sold_date > now() - interval '24 hours'
  GROUP BY i.item_id`)).rows;
const byId = new Map(rows.map((row) => [row.itemId, row]));
for (const row of collected) {
  byId.set(row.item_id, {
    itemId: row.item_id,
    itemName: row.item_name,
    itemRarity: row.item_rarity,
    itemTypeDetail: row.item_type_detail,
    turnover24: row.turnover_24h,
    observedQty: row.observed_qty,
    trades: row.trade_count,
    lastPrice: row.last_price,
    spanMinutes: null,
    basis: 'collected',
  });
}

rows.length = 0;
rows.push(...byId.values());
rows.sort((a, b) => b.turnover24 - a.turnover24 || a.itemName.localeCompare(b.itemName, 'ko'));
const top = rows.slice(0, 100);
const capturedAt = new Date(now);
await tx(async (client) => {
  for (let rank = 0; rank < top.length; rank++) {
    const row = top[rank];
    await client.query(`INSERT INTO market_rankings
      (captured_at, rank, item_id, item_name, item_rarity, item_type_detail,
       turnover_24h, observed_qty, trade_count, last_price, basis, span_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
      capturedAt, rank + 1, row.itemId, row.itemName, row.itemRarity, row.itemTypeDetail,
      row.turnover24, row.observedQty, row.trades, row.lastPrice, row.basis, row.spanMinutes,
    ]);
  }
  await client.query("DELETE FROM market_rankings WHERE captured_at < now() - interval '7 days'");
});

const basisCounts = Object.groupBy(top, (row) => row.basis);
console.log(`저장 완료 — ${top.length}종 · 연속수집 ${basisCounts.collected?.length ?? 0}` +
  ` · 24h 완전조회 ${basisCounts.api_complete?.length ?? 0} · 24h 환산 ${basisCounts.estimated?.length ?? 0}` +
  ` · 조회 실패 ${failures}`);
for (const [index, row] of top.slice(0, 20).entries()) {
  console.log(`${String(index + 1).padStart(3)}. ${row.itemName}  ${row.turnover24.toLocaleString()}  ${row.basis}`);
}
await pool.end();
