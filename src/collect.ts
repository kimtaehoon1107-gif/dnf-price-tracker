// 아이템 1개에 대한 수집 1회분.
//
// 두 흐름을 모두 가져온다:
//   체결(auction-sold) → trades          "얼마에 팔렸나"
//   호가(auction)      → listings/deltas "얼마에 팔려고 하나" + 매물 소진 관측

import { getSold, getAuction, kstToIso, type AuctionRow } from './api.ts';
import { db, nowIso, quantile } from './db.ts';

const insTrade = db.prepare(`
  INSERT OR IGNORE INTO trades
    (item_id, sold_date, unit_price, count, price, reinforce, refine, amplification_name, dup_seq, ingested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const upsertListing = db.prepare(`
  INSERT INTO listings
    (auction_no, item_id, reg_date, expire_date, unit_price, reg_count, cur_count, reinforce, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(auction_no) DO UPDATE SET
    cur_count = excluded.cur_count,
    unit_price = excluded.unit_price,
    last_seen_at = excluded.last_seen_at`);

const insDelta = db.prepare(`
  INSERT INTO listing_deltas
    (auction_no, item_id, unit_price, qty_sold, prev_count, new_count, observed_at, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

const insSnapshot = db.prepare(`
  INSERT OR IGNORE INTO listing_snapshots
    (item_id, captured_at, min_unit_price, p10, p25, median, listing_count, total_qty)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

const closeListing = db.prepare('UPDATE listings SET closed_at = ? WHERE auction_no = ?');
const openListings = db.prepare('SELECT * FROM listings WHERE item_id = ? AND closed_at IS NULL');
const lastRunAt = db.prepare(
  'SELECT MAX(started_at) AS t FROM collection_runs WHERE item_id = ? AND error IS NULL');
const startRun = db.prepare('INSERT INTO collection_runs (item_id, started_at) VALUES (?, ?)');
const finishRun = db.prepare(`
  UPDATE collection_runs SET
    finished_at = ?, sold_rows = ?, sold_new = ?, sold_span_min = ?,
    saturated = ?, listing_rows = ?, deltas_found = ?, error = ?
  WHERE id = ?`);

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

export async function collectItem(itemId: string, soldLimit = 100): Promise<CollectResult> {
  const startedAt = nowIso();
  const prevRun = (lastRunAt.get(itemId) as { t: string | null } | undefined)?.t ?? null;
  const runId = startRun.run(itemId, startedAt).lastInsertRowid as number;

  try {
    // ── 1. 체결 내역 ────────────────────────────────────────────
    const sold = await getSold(itemId, soldLimit);
    const soldTimes = sold.map((r) => kstToIso(r.soldDate)).sort();
    const spanMin = soldTimes.length > 1
      ? (Date.parse(soldTimes.at(-1)!) - Date.parse(soldTimes[0])) / 60_000
      : null;

    // 포화 판정: 100건이 꽉 찼는데 가장 오래된 거래가 직전 폴링보다 최신이라면,
    // 그 사이에 100건을 넘는 거래가 있었다는 뜻 — 놓친 거래가 존재한다.
    const saturated = sold.length >= soldLimit && prevRun !== null && soldTimes[0] > prevRun;

    let soldNew = 0;
    db.exec('BEGIN');
    try {
      const ingestedAt = nowIso();
      // 응답 안의 동일키에 순번을 매긴다. 같은 초·같은 가격·같은 수량의 별개 체결이
      // 실제로 존재하므로(대량 매수), 순번 없이는 그만큼 통째로 유실된다.
      const seqOf = new Map<string, number>();
      for (const r of sold) {
        const soldDate = kstToIso(r.soldDate);
        const key = `${soldDate}|${r.unitPrice}|${r.count}|${r.reinforce}`;
        const seq = seqOf.get(key) ?? 0;
        seqOf.set(key, seq + 1);
        const res = insTrade.run(
          itemId, soldDate, r.unitPrice, r.count, r.price,
          r.reinforce, r.refine, r.amplificationName, seq, ingestedAt);
        soldNew += res.changes;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // ── 2. 현재 매물 + 소진 관측 ────────────────────────────────
    const listings = await getAuction(itemId, 400);
    const capped = listings.length >= 400;
    const observedAt = nowIso();
    const prev = openListings.all(itemId) as Array<{
      auction_no: number; unit_price: number; cur_count: number; expire_date: string;
    }>;
    const prevByNo = new Map(prev.map((p) => [p.auction_no, p]));
    const seen = new Set(listings.map((r) => r.auctionNo));

    let deltas = 0;
    let qtyObserved = 0;

    db.exec('BEGIN');
    try {
      for (const r of listings) {
        const before = prevByNo.get(r.auctionNo);
        if (before && r.count < before.cur_count) {
          const qty = before.cur_count - r.count;
          insDelta.run(r.auctionNo, itemId, r.unitPrice, qty, before.cur_count, r.count, observedAt, 'partial');
          deltas++;
          qtyObserved += qty;
        }
        // regCount는 스태커블 아이템에만 온다. 아바타·장비 단품에는 없으므로
        // 그때는 등록 수량을 잔여 수량과 같게 본다(부분 판매가 불가능한 매물).
        upsertListing.run(
          r.auctionNo, itemId, kstToIso(r.regDate), kstToIso(r.expireDate),
          r.unitPrice, r.regCount ?? r.count, r.count, r.reinforce, observedAt, observedAt);
      }

      // 사라진 매물: 완판이거나 만료. 단 응답이 400건으로 잘렸다면
      // 잘려나간 고가 매물을 "사라졌다"고 오판하지 않도록 가격 상한 안쪽만 본다.
      const priceCeiling = capped ? Math.max(...listings.map((r) => r.unitPrice)) : Infinity;
      for (const p of prev) {
        if (seen.has(p.auction_no) || p.unit_price > priceCeiling) continue;
        const expired = observedAt >= p.expire_date;
        if (p.cur_count > 0 && !expired) {
          insDelta.run(p.auction_no, itemId, p.unit_price, p.cur_count, p.cur_count, 0,
            observedAt, 'vanished_before_expiry');
          deltas++;
          qtyObserved += p.cur_count;
        } else if (expired) {
          insDelta.run(p.auction_no, itemId, p.unit_price, 0, p.cur_count, p.cur_count,
            observedAt, 'expired');
        }
        closeListing.run(observedAt, p.auction_no);
      }

      // ── 3. 호가 분포 요약 ─────────────────────────────────────
      const prices = listings.map((r) => r.unitPrice).sort((a, b) => a - b);
      insSnapshot.run(
        itemId, observedAt,
        prices[0] ?? null, quantile(prices, 0.1), quantile(prices, 0.25), quantile(prices, 0.5),
        listings.length, listings.reduce((s, r) => s + r.count, 0));

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    finishRun.run(nowIso(), sold.length, soldNew, spanMin, saturated ? 1 : 0,
      listings.length, deltas, null, runId);

    return { itemId, soldRows: sold.length, soldNew, spanMin, saturated,
      listingRows: listings.length, deltas, qtyObserved };
  } catch (e) {
    finishRun.run(nowIso(), 0, 0, null, 0, 0, 0, String(e), runId);
    throw e;
  }
}

// 단발 실행: npm run collect:once -- <itemId>
if (import.meta.filename === process.argv[1]) {
  const target = process.argv[2];
  const ids = target
    ? [target]
    : (db.prepare('SELECT item_id FROM items WHERE tracked = 1').all() as Array<{ item_id: string }>)
        .map((r) => r.item_id);

  for (const id of ids) {
    const r = await collectItem(id);
    const name = (db.prepare('SELECT item_name FROM items WHERE item_id = ?').get(id) as
      { item_name: string } | undefined)?.item_name ?? id;
    console.log(
      `${name.padEnd(22)} 체결 ${String(r.soldRows).padStart(3)}건(신규 ${String(r.soldNew).padStart(3)})` +
      `  span ${r.spanMin === null ? '  -  ' : r.spanMin.toFixed(1).padStart(7)}분` +
      `  매물 ${String(r.listingRows).padStart(3)}  소진 ${String(r.deltas).padStart(2)}건/${r.qtyObserved}개` +
      (r.saturated ? '  ⚠ 포화 — 주기를 줄여야 함' : ''));
  }
}
