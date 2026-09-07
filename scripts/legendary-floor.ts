// 레전더리 카드 최저가 지수.
//
// 레전더리 카드는 개별 시세보다 "가장 싼 게 얼마냐"가 중요하다 — 합성이나
// 카드 강화에 재료로 들어가기 때문에, 이 값이 곧 재료비의 하한선이다.
// 어느 카드가 최저가인지는 수시로 바뀌므로 전체를 훑어서 바닥을 찾는다.
//
//   node --env-file=.env --no-warnings scripts/legendary-floor.ts
//
// 카탈로그(discover.ts 산출물)에 있는 레전더리 카드 전종을 스캔한다.
// 카탈로그가 완전하지 않으므로 이 값은 "우리가 아는 범위의 최저가"다.

import { readFileSync } from 'node:fs';
import { getAuction } from '../src/api.ts';
import { query, pool } from '../src/db.ts';

await query(`
  CREATE TABLE IF NOT EXISTS legendary_card_floor (
    id             BIGSERIAL PRIMARY KEY,
    captured_at    TIMESTAMPTZ NOT NULL,
    min_unit_price BIGINT      NOT NULL,
    min_item_id    TEXT        NOT NULL,
    min_item_name  TEXT        NOT NULL,
    p10            BIGINT,
    median         BIGINT,
    scanned        INTEGER     NOT NULL,   -- 스캔한 카드 종수
    with_listings  INTEGER     NOT NULL,   -- 그중 매물이 있던 종수
    total_listings INTEGER     NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lcf_time ON legendary_card_floor (captured_at);`);

const cards = (JSON.parse(readFileSync('data/catalog.json', 'utf8')) as Array<{
  itemId: string; itemName: string; itemRarity: string;
}>).filter((r) => r.itemRarity === '레전더리' && /카드$/.test(r.itemName));

const found: Array<{ id: string; name: string; price: number; listings: number }> = [];
for (let i = 0; i < cards.length; i += 10) {
  await Promise.all(cards.slice(i, i + 10).map(async (c) => {
    try {
      // 최저가만 필요하므로 가격 오름차순 1건이면 충분하다
      const a = await getAuction(c.itemId, 1);
      if (a.length) found.push({ id: c.itemId, name: c.itemName, price: a[0].unitPrice, listings: a.length });
    } catch { /* 개별 실패는 무시 */ }
  }));
}

if (found.length === 0) {
  console.error('매물이 있는 레전더리 카드를 하나도 찾지 못했습니다.');
  await pool.end();
  process.exit(1);
}

found.sort((a, b) => a.price - b.price);
const q = (f: number) => found[Math.min(found.length - 1, Math.floor(found.length * f))].price;
const now = new Date().toISOString();

await query(`INSERT INTO legendary_card_floor
  (captured_at, min_unit_price, min_item_id, min_item_name, p10, median, scanned, with_listings, total_listings)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [now, found[0].price, found[0].id, found[0].name, q(0.1), q(0.5),
   cards.length, found.length, found.reduce((s, f) => s + f.listings, 0)]);

console.log(`레전더리 카드 ${cards.length}종 스캔 · 매물 있는 것 ${found.length}종`);
console.log(`최저가  ${found[0].price.toLocaleString()} 골드  — ${found[0].name}`);
console.log(`p10     ${q(0.1).toLocaleString()}`);
console.log(`중앙값  ${q(0.5).toLocaleString()}`);
console.log('\n최저가 5종:');
found.slice(0, 5).forEach((f) => console.log(`  ${f.price.toLocaleString().padStart(12)}  ${f.name}`));
await pool.end();
