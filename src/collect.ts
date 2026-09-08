// 아이템 1개에 대한 수집 1회분.
//
// 두 흐름을 모두 가져온다:
//   체결(auction-sold) → trades           "얼마에 팔렸나"
//   호가(auction)      → listings/deltas  "얼마에 팔려고 하나" + 매물 소진 관측
//
// 쓰기는 전부 한 트랜잭션 안에서 한다. 중간에 죽어도 반쪽 데이터가 남지 않는다.

import { getSold, getAuction, kstToIso } from './api.ts';
import { query, tx, nowIso, quantile } from './db.ts';
import { duplicateSequences, isSaturated, selectCardListings } from './market-logic.ts';

export interface CollectResult {
  itemId: string;
  soldRows: number;
  soldNew: number;
  spanMin: number | null;
  saturated: boolean;
  listingRows: number;
  deltas: number;
  qtyObserved: number;
}

export type CollectionSource = 'local' | 'manual' | 'actions';

export async function collectItem(
  itemId: string,
  soldLimit = 100,
  source: CollectionSource = 'local',
): Promise<CollectResult> {
  const startedAt = nowIso();
  const context = await query<{ category: string | null; upgrade_max: number | null; t: Date | null }>(`
    SELECT i.category,
      (SELECT MAX(upgrade_max) FROM listings WHERE item_id = i.item_id) AS upgrade_max,
      (SELECT MAX(started_at) FROM collection_runs
       WHERE item_id = i.item_id AND error IS NULL AND finished_at IS NOT NULL) AS t
    FROM items i WHERE i.item_id = $1`, [itemId]);
  const isCard = context.rows[0]?.category === '카드';
  const prevRun = context.rows[0]?.t ? context.rows[0].t.toISOString() : null;

  const run = await query<{ id: string }>(
    'INSERT INTO collection_runs (item_id, source, started_at) VALUES ($1, $2, $3) RETURNING id',
    [itemId, source, startedAt]);
  const runId = run.rows[0].id;

  try {
    // ── 1. 체결 내역 ────────────────────────────────────────────
    // 체결 API에는 카드 upgrade가 없다. fame도 0업과 1업이 같을 수 있으므로
    // 정확한 0업만 고를 수 없다. 섞인 가격을 만들지 않도록 카드는 체결을 저장하지 않고
    // upgrade가 명시된 현재 매물만 시계열로 쌓는다.
    const sold = isCard ? [] : await getSold(itemId, soldLimit);
    const soldTimes = sold.map((r) => kstToIso(r.soldDate)).sort();
    const spanMin = soldTimes.length > 1
      ? (Date.parse(soldTimes.at(-1)!) - Date.parse(soldTimes[0])) / 60_000
      : null;

    // 포화 판정: 100건이 꽉 찼는데 가장 오래된 거래도 직전 폴링보다 최신이면
    // 응답이 이전 구간과 겹치지 않는다. 정확히 100건일 수도 있어 누락 확정은 아니지만,
    // 그보다 많았다면 초과분은 알 수 없으므로 다음 폴링부터 주기를 줄인다.
    const saturated = isSaturated(sold.length, soldLimit, soldTimes[0], prevRun);

    // 응답 안의 동일키에 순번을 매긴다. 같은 초·같은 가격·같은 수량의 별개 체결이
    // 실제로 존재하므로(대량 매수), 순번 없이는 그만큼 통째로 유실된다.
    const dupSequences = duplicateSequences(sold.map((row) => ({
      soldDate: kstToIso(row.soldDate),
      unitPrice: row.unitPrice,
      count: row.count,
      reinforce: row.reinforce,
    })));
    const T = {
      soldDate: [] as string[], unitPrice: [] as number[], count: [] as number[],
      price: [] as number[], reinforce: [] as number[], refine: [] as number[],
      amp: [] as (string | null)[], dupSeq: [] as number[],
    };
    for (const [index, r] of sold.entries()) {
      const soldDate = kstToIso(r.soldDate);
      T.soldDate.push(soldDate); T.unitPrice.push(r.unitPrice); T.count.push(r.count);
      T.price.push(r.price); T.reinforce.push(r.reinforce); T.refine.push(r.refine);
      T.amp.push(r.amplificationName); T.dupSeq.push(dupSequences[index]);
    }

    // ── 2. 현재 매물 ────────────────────────────────────────────
    const auction = await getAuction(itemId, 400);
    const observedUpgradeMaxes = [...new Set(auction
      .map((r) => r.upgradeMax)
      .filter((value): value is number => Number.isInteger(value) && value > 0))];
    if (isCard && observedUpgradeMaxes.length > 1) {
      throw new Error(`카드 최대 업그레이드 단계 불일치: ${observedUpgradeMaxes.join(', ')}`);
    }
    const cardUpgradeMax = isCard ? (observedUpgradeMaxes[0] ?? context.rows[0]?.upgrade_max ?? null) : null;
    const listings = isCard ? selectCardListings(auction, cardUpgradeMax) : auction;
    const capped = auction.length >= 400;
    const observedAt = nowIso();

    if (isCard) {
      // 구버전 수집기가 단계 정보 없이 남긴 열린 매물은 0업과 섞지 않는다.
      await query(`UPDATE listings SET closed_at = $2
        WHERE item_id = $1 AND closed_at IS NULL AND upgrade IS NULL`, [itemId, observedAt]);
    }
    const open = await query<{ auction_no: string; unit_price: number; cur_count: number; expire_date: Date }>(
      `SELECT auction_no, unit_price, cur_count, expire_date FROM listings
       WHERE item_id = $1 AND closed_at IS NULL
         AND ($2::boolean = false OR upgrade = 0 OR upgrade = upgrade_max)`,
      [itemId, isCard]);
    const prevByNo = new Map(open.rows.map((p) => [Number(p.auction_no), p]));
    const seen = new Set(listings.map((r) => r.auctionNo));

    const D = {
      auctionNo: [] as number[], unitPrice: [] as number[], qty: [] as number[],
      prevCount: [] as number[], newCount: [] as number[], reason: [] as string[],
    };
    const pushDelta = (no: number, up: number, qty: number, p: number, n: number, reason: string) => {
      D.auctionNo.push(no); D.unitPrice.push(up); D.qty.push(qty);
      D.prevCount.push(p); D.newCount.push(n); D.reason.push(reason);
    };

    let qtyObserved = 0;
    const L = {
      auctionNo: [] as number[], regDate: [] as string[], expireDate: [] as string[],
      unitPrice: [] as number[], regCount: [] as number[], curCount: [] as number[],
      reinforce: [] as number[], fame: [] as (number | null)[],
      upgrade: [] as (number | null)[], upgradeMax: [] as (number | null)[],
    };
    for (const r of listings) {
      const before = prevByNo.get(r.auctionNo);
      if (before && r.count < before.cur_count) {
        const qty = before.cur_count - r.count;
        pushDelta(r.auctionNo, r.unitPrice, qty, before.cur_count, r.count, 'partial');
        qtyObserved += qty;
      }
      L.auctionNo.push(r.auctionNo);
      L.regDate.push(kstToIso(r.regDate));
      L.expireDate.push(kstToIso(r.expireDate));
      L.unitPrice.push(r.unitPrice);
      // regCount는 스태커블 매물에만 온다. 아바타·장비 단품에는 없으므로
      // 그때는 등록 수량을 잔여 수량과 같게 본다(부분 판매가 불가능한 매물).
      L.regCount.push(r.regCount ?? r.count);
      L.curCount.push(r.count);
      L.reinforce.push(r.reinforce);
      L.fame.push(r.fame ?? null);
      L.upgrade.push(r.upgrade ?? null);
      L.upgradeMax.push(r.upgradeMax ?? null);
    }

    // 사라진 매물: 완판이거나 만료. 단 응답이 400건으로 잘렸다면
    // 잘려나간 고가 매물을 "사라졌다"고 오판하지 않도록 가격 상한 안쪽만 본다.
    const priceCeiling = capped ? Math.max(...auction.map((r) => r.unitPrice)) : Infinity;
    const toClose: number[] = [];
    for (const [no, p] of prevByNo) {
      if (seen.has(no) || p.unit_price > priceCeiling) continue;
      const expired = Date.parse(observedAt) >= p.expire_date.getTime();
      if (p.cur_count > 0 && !expired) {
        pushDelta(no, p.unit_price, p.cur_count, p.cur_count, 0, 'vanished_before_expiry');
        qtyObserved += p.cur_count;
      } else if (expired) {
        pushDelta(no, p.unit_price, 0, p.cur_count, p.cur_count, 'expired');
      }
      toClose.push(no);
    }

    // ── 3. 한 트랜잭션으로 기록 ─────────────────────────────────
    const soldNew = await tx(async (c) => {
      const ins = await c.query(`
        INSERT INTO trades (item_id, sold_date, unit_price, count, price, reinforce, refine, amplification_name, dup_seq)
        SELECT $1, u.* FROM UNNEST(
          $2::timestamptz[], $3::bigint[], $4::int[], $5::bigint[], $6::int[], $7::int[], $8::text[], $9::int[]
        ) AS u(sold_date, unit_price, count, price, reinforce, refine, amp, dup_seq)
        ON CONFLICT DO NOTHING`,
        [itemId, T.soldDate, T.unitPrice, T.count, T.price, T.reinforce, T.refine, T.amp, T.dupSeq]);

      await c.query(`
        INSERT INTO listings (auction_no, item_id, reg_date, expire_date, unit_price, reg_count, cur_count,
                              reinforce, fame, upgrade, upgrade_max, first_seen_at, last_seen_at)
        SELECT u.auction_no, $1, u.reg_date, u.expire_date, u.unit_price, u.reg_count, u.cur_count,
               u.reinforce, u.fame, u.upgrade, u.upgrade_max, $12, $12
        FROM UNNEST(
          $2::bigint[], $3::timestamptz[], $4::timestamptz[], $5::bigint[], $6::int[], $7::int[],
          $8::int[], $9::int[], $10::int[], $11::int[]
        ) AS u(auction_no, reg_date, expire_date, unit_price, reg_count, cur_count, reinforce, fame, upgrade, upgrade_max)
        ON CONFLICT (auction_no) DO UPDATE SET
          cur_count = EXCLUDED.cur_count,
          unit_price = EXCLUDED.unit_price,
          fame = EXCLUDED.fame,
          upgrade = EXCLUDED.upgrade,
          upgrade_max = EXCLUDED.upgrade_max,
          last_seen_at = EXCLUDED.last_seen_at,
          closed_at = NULL`,
        [itemId, L.auctionNo, L.regDate, L.expireDate, L.unitPrice, L.regCount, L.curCount,
         L.reinforce, L.fame, L.upgrade, L.upgradeMax, observedAt]);

      await c.query(`
        INSERT INTO listing_deltas (auction_no, item_id, unit_price, qty_sold, prev_count, new_count, observed_at, reason)
        SELECT u.auction_no, $1, u.unit_price, u.qty_sold, u.prev_count, u.new_count, $7, u.reason
        FROM UNNEST($2::bigint[], $3::bigint[], $4::int[], $5::int[], $6::int[], $8::text[])
          AS u(auction_no, unit_price, qty_sold, prev_count, new_count, reason)`,
        [itemId, D.auctionNo, D.unitPrice, D.qty, D.prevCount, D.newCount, observedAt, D.reason]);

      if (toClose.length) {
        await c.query('UPDATE listings SET closed_at = $1 WHERE auction_no = ANY($2::bigint[])',
          [observedAt, toClose]);
      }

      const snapshotGroups = isCard
        ? [0, ...(cardUpgradeMax === null ? [] : [cardUpgradeMax])].map((upgrade) => ({
            upgrade,
            rows: listings.filter((row) => row.upgrade === upgrade),
          }))
        : [{ upgrade: null, rows: listings }];
      for (const group of snapshotGroups) {
        const groupPrices = group.rows.map((row) => row.unitPrice).sort((a, b) => a - b);
        await c.query(`
          INSERT INTO listing_snapshots
            (item_id, captured_at, min_unit_price, p10, p25, median, listing_count, total_qty, upgrade, upgrade_max)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [itemId, observedAt, groupPrices[0] ?? null, quantile(groupPrices, 0.1), quantile(groupPrices, 0.25),
            quantile(groupPrices, 0.5), group.rows.length, group.rows.reduce((s, r) => s + r.count, 0),
            group.upgrade, cardUpgradeMax]);
      }

      return ins.rowCount ?? 0;
    });

    await query(`
      UPDATE collection_runs SET finished_at = $1, sold_rows = $2, sold_new = $3, sold_span_min = $4,
        saturated = $5, listing_rows = $6, deltas_found = $7 WHERE id = $8`,
      [nowIso(), sold.length, soldNew, spanMin, saturated, listings.length, D.auctionNo.length, runId]);

    return { itemId, soldRows: sold.length, soldNew, spanMin, saturated,
      listingRows: listings.length, deltas: D.auctionNo.length, qtyObserved };
  } catch (e) {
    await query('UPDATE collection_runs SET finished_at = $1, error = $2 WHERE id = $3',
      [nowIso(), String(e), runId]).catch(() => {});
    throw e;
  }
}
