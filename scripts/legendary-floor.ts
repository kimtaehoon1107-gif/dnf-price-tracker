// 레전더리 카드 최저가 지수.
//
// 레전더리 카드는 개별 시세보다 "가장 싼 게 얼마냐"가 중요하다 — 합성이나
// 카드 강화에 재료로 들어가기 때문에, 이 값이 곧 재료비의 하한선이다.
// 어느 카드가 최저가인지는 수시로 바뀌므로 전체를 훑어서 바닥을 찾는다.
//
//   node --env-file=.env --no-warnings scripts/legendary-floor.ts
//
// 리포에 고정한 레전더리 카드 목록을 전부 스캔한다. 전체 카탈로그는 27MB라
// Actions 러너에 싣지 않고, 필요한 itemId와 이름만 별도 파일로 관리한다.

import { readFileSync } from 'node:fs';
import { getAuction } from '../src/api.ts';
import { pool } from '../src/db.ts';

const LOCK_KEY_1 = 20260908;
const LOCK_KEY_2 = 1;
const MIN_INTERVAL_MS = 55 * 60 * 1000;

async function main() {
  // push 배포와 매시 pg_cron 배포가 겹쳐도 스캔은 한 프로세스만 맡는다.
  // 같은 연결을 끝까지 유지해야 세션 자문 잠금도 스캔 동안 유지된다.
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_KEY_1, LOCK_KEY_2],
    )).rows[0].locked;
    if (!locked) {
      console.log('다른 레전더리 카드 저가 스캔이 진행 중이라 건너뜁니다.');
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS legendary_card_floor (
        id             BIGSERIAL PRIMARY KEY,
        captured_at    TIMESTAMPTZ NOT NULL,
        min_unit_price BIGINT      NOT NULL,
        min_item_id    TEXT        NOT NULL,
        min_item_name  TEXT        NOT NULL,
        p10            BIGINT,
        median         BIGINT,
        scanned        INTEGER     NOT NULL,
        with_listings  INTEGER     NOT NULL,
        total_listings INTEGER     NOT NULL,
        upgrade        INTEGER
      );
      ALTER TABLE legendary_card_floor ADD COLUMN IF NOT EXISTS upgrade INTEGER;
      CREATE INDEX IF NOT EXISTS idx_lcf_time ON legendary_card_floor (captured_at);`);

    const force = process.argv.includes('--force');
    const latest = (await client.query<{ captured_at: Date | null }>(`
      SELECT MAX(captured_at) AS captured_at
      FROM legendary_card_floor
      WHERE upgrade = 0`)).rows[0]?.captured_at;
    if (!force && latest && Date.now() - new Date(latest).getTime() < MIN_INTERVAL_MS) {
      console.log(`최근 저가 지표가 있어 건너뜁니다 — ${new Date(latest).toISOString()}`);
      return;
    }

    const cards = JSON.parse(readFileSync('data/legendary-cards.json', 'utf8')) as Array<{
      itemId: string; itemName: string;
    }>;
    const found: Array<{ id: string; name: string; price: number; listings: number }> = [];
    for (let i = 0; i < cards.length; i += 10) {
      await Promise.all(cards.slice(i, i + 10).map(async (card) => {
        try {
          // 카드 itemId 하나에 0~최대 업그레이드 매물이 함께 온다.
          // API가 명시한 upgrade=0만 남긴 뒤 최저가를 고른다.
          const auctions = (await getAuction(card.itemId, 400)).filter((row) => row.upgrade === 0);
          if (auctions.length) {
            found.push({ id: card.itemId, name: card.itemName, price: auctions[0].unitPrice, listings: auctions.length });
          }
        } catch { /* 개별 실패는 무시 */ }
      }));
    }

    if (found.length === 0) throw new Error('매물이 있는 레전더리 카드를 하나도 찾지 못했습니다.');

    // 동률이면 Promise.all 완료 순서가 아니라 itemId로 고정해 결과를 재현 가능하게 한다.
    found.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
    const quantile = (fraction: number) =>
      found[Math.min(found.length - 1, Math.floor(found.length * fraction))].price;
    const now = new Date().toISOString();

    await client.query(`INSERT INTO legendary_card_floor
      (captured_at, min_unit_price, min_item_id, min_item_name, p10, median,
       scanned, with_listings, total_listings, upgrade)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)`,
    [now, found[0].price, found[0].id, found[0].name, quantile(0.1), quantile(0.5),
      cards.length, found.length, found.reduce((sum, row) => sum + row.listings, 0)]);

    console.log(`레전더리 카드 ${cards.length}종 스캔 · 매물 있는 것 ${found.length}종`);
    console.log(`최저가  ${found[0].price.toLocaleString()} 골드  — ${found[0].name}`);
    console.log(`p10     ${quantile(0.1).toLocaleString()}`);
    console.log(`중앙값  ${quantile(0.5).toLocaleString()}`);
    console.log('\n최저가 5종:');
    found.slice(0, 5).forEach((row) => console.log(`  ${row.price.toLocaleString().padStart(12)}  ${row.name}`));
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]).catch(() => {});
    }
    client.release();
  }
}

try {
  await main();
} finally {
  await pool.end();
}
