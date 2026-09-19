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
const HOUR_MS = 60 * 60 * 1000;
type CardObservation = {
  itemId: string; itemName: string; status: 'pending' | 'observed' | 'empty' | 'failed';
  capturedAt?: string; minPrice?: number | null; listingCount?: number;
  responseRows?: number; capped?: boolean; errorCode?: string;
};

async function main() {
  // push 배포와 매시 pg_cron 배포가 겹쳐도 스캔은 한 프로세스만 맡는다.
  // 같은 연결을 끝까지 유지해야 세션 자문 잠금도 스캔 동안 유지된다.
  const client = await pool.connect();
  let locked = false;
  let scanId: number | undefined, finished = false;
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
    await client.query(readFileSync('sql/legendary-scans.sql', 'utf8'));
    // 같은 잠금을 얻었으므로 남아 있는 running 실행은 종료되거나 강제 중단된 것이다.
    await client.query(`UPDATE legendary_card_scans SET status='interrupted',finished_at=clock_timestamp()
      WHERE status='running'`);

    const force = process.argv.includes('--force');
    const latest = (await client.query<{ captured_at: Date | null }>(`
      SELECT MAX(captured_at) AS captured_at
      FROM legendary_card_floor
      WHERE upgrade = 0`)).rows[0]?.captured_at;
    // 앞선 집계가 늦어져도 다음 시간의 관측을 건너뛰지 않는다.
    // 차트와 같은 정시 구간으로 중복을 판단한다(UTC와 KST의 시간 경계는 같다).
    if (!force && latest && Math.floor(new Date(latest).getTime() / HOUR_MS) === Math.floor(Date.now() / HOUR_MS)) {
      console.log(`현재 시간대의 저가 지표가 있어 건너뜁니다 — ${new Date(latest).toISOString()}`);
      return;
    }

    const cards = JSON.parse(readFileSync('data/legendary-cards.json', 'utf8')) as Array<{
      itemId: string; itemName: string;
    }>;
    const observations: CardObservation[] = cards.map((card) => ({ ...card, status: 'pending' }));
    scanId = (await client.query<{ id: number }>(`INSERT INTO legendary_card_scans
      (started_at,status,expected,observations) VALUES ($1,'running',$2,$3) RETURNING id`,
    [new Date().toISOString(), cards.length, JSON.stringify(observations)])).rows[0].id;
    const found: Array<{ id: string; name: string; price: number; listings: number }> = [];
    let failures = 0;
    for (let i = 0; i < cards.length; i += 10) {
      await Promise.all(cards.slice(i, i + 10).map(async (card, offset) => {
        try {
          // 카드 itemId 하나에 0~최대 업그레이드 매물이 함께 온다.
          // API가 명시한 upgrade=0만 남긴 뒤 최저가를 고른다.
          const response = await getAuction(card.itemId, 400);
          const auctions = response.filter((row) => row.upgrade === 0);
          observations[i + offset] = { ...card, capturedAt: new Date().toISOString(),
            status: auctions.length ? 'observed' : 'empty', minPrice: auctions[0]?.unitPrice ?? null,
            listingCount: auctions.length, responseRows: response.length, capped: response.length >= 400 };
          if (auctions.length) {
            found.push({ id: card.itemId, name: card.itemName, price: auctions[0].unitPrice, listings: auctions.length });
          }
        } catch (error) {
          failures++;
          // 응답 본문·URL·인증값은 저장하지 않는다. HTTP 코드만 제한해서 추출한다.
          const http = error instanceof Error ? error.message.match(/ → ([45]\d{2})\b/)?.[1] : undefined;
          observations[i + offset] = { ...card, capturedAt: new Date().toISOString(), status: 'failed',
            errorCode: http ? `http_${http}` : 'api_request_failed' };
        }
      }));
      // 묶음마다 보존해 중도 종료가 전체 165종의 관측을 지우지 않게 한다.
      await client.query(`UPDATE legendary_card_scans SET observations=$2,succeeded=$3,failed=$4 WHERE id=$1`,
      [scanId, JSON.stringify(observations), Math.min(i + 10, cards.length) - failures, failures]);
    }

    if (failures) console.warn(`레전더리 카드 API 조회 실패 ${failures}/${cards.length}종`);
    if (failures || found.length === 0) {
      await client.query(`UPDATE legendary_card_scans SET status=$2,finished_at=clock_timestamp() WHERE id=$1`,
      [scanId, failures === cards.length ? 'failed' : failures ? 'partial' : 'complete']);
      finished = true;
      // 일부 카드의 가격을 모르면 전체 최저가·P10으로 발표하지 않는다. 같은 시간 재시도 가능.
      if (failures && found.length) {
        console.warn('일부 카드 조회 실패로 이번 지수 발행을 보류합니다. 카드별 결과는 보존하고 다른 사이트 데이터는 갱신합니다.');
        return;
      }
      throw new Error(failures === cards.length
        ? '레전더리 카드 API 조회가 모두 실패하여 이번 시간의 가격을 관측하지 못했습니다.'
        : '정상 응답에서 0업 매물을 찾지 못했습니다. 카드별 결과와 조회 실패 기록은 보존했습니다.');
    }

    // 동률이면 Promise.all 완료 순서가 아니라 itemId로 고정해 결과를 재현 가능하게 한다.
    found.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
    const quantile = (fraction: number) =>
      found[Math.min(found.length - 1, Math.floor(found.length * fraction))].price;
    const now = new Date().toISOString();

    await client.query('BEGIN');
    await client.query(`INSERT INTO legendary_card_floor
      (captured_at, min_unit_price, min_item_id, min_item_name, p10, median,
       scanned, with_listings, total_listings, upgrade)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)`,
    [now, found[0].price, found[0].id, found[0].name, quantile(0.1), quantile(0.5),
      cards.length, found.length, found.reduce((sum, row) => sum + row.listings, 0)]);
    await client.query(`UPDATE legendary_card_scans SET status='complete',finished_at=$2 WHERE id=$1`, [scanId, now]);
    await client.query('COMMIT');
    finished = true;

    console.log(`레전더리 카드 ${cards.length}종 스캔 · 매물 있는 것 ${found.length}종`);
    console.log(`최저가  ${found[0].price.toLocaleString()} 골드  — ${found[0].name}`);
    console.log(`p10     ${quantile(0.1).toLocaleString()}`);
    console.log(`중앙값  ${quantile(0.5).toLocaleString()}`);
    console.log('\n최저가 5종:');
    found.slice(0, 5).forEach((row) => console.log(`  ${row.price.toLocaleString().padStart(12)}  ${row.name}`));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (scanId !== undefined && !finished) {
      await client.query(`UPDATE legendary_card_scans SET status='interrupted',finished_at=clock_timestamp()
        WHERE id=$1`, [scanId]).catch(() => {});
    }
    throw error;
  } finally {
    let destroy = false;
    if (locked) {
      try {
        destroy = !(await client.query('SELECT pg_advisory_unlock($1, $2) AS ok', [LOCK_KEY_1, LOCK_KEY_2])).rows[0].ok;
      } catch { destroy = true; }
    }
    client.release(destroy);
  }
}

try {
  await main();
} finally {
  await pool.end();
}
