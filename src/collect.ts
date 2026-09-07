// 아이템 1개에 대한 수집 1회분.
//
// 두 흐름을 모두 가져온다:
//   체결(auction-sold) → trades           "얼마에 팔렸나"
//   호가(auction)      → listings/deltas  "얼마에 팔려고 하나" + 매물 소진 관측
//
// 쓰기는 전부 한 트랜잭션 안에서 한다. 중간에 죽어도 반쪽 데이터가 남지 않는다.

import { getSold, getAuction, kstToIso } from './api.ts';
import { query, tx, nowIso, quantile } from './db.ts';

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
  const prev = await query<{ t: Date | null }>(
    'SELECT MAX(started_at) AS t FROM collection_runs WHERE item_id = $1 AND error IS NULL', [itemId]);
  const prevRun = prev.rows[0]?.t ? prev.rows[0].t.toISOString() : null;

  const run = await query<{ id: string }>(
    'INSERT INTO collection_runs (item_id, started_at) VALUES ($1, $2) RETURNING id', [itemId, startedAt]);
  const runId = run.rows[0].id;

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

    // 응답 안의 동일키에 순번을 매긴다. 같은 초·같은 가격·같은 수량의 별개 체결이
    // 실제로 존재하므로(대량 매수), 순번 없이는 그만큼 통째로 유실된다.
    const seqOf = new Map<string, number>();
    const T = {
      soldDate: [] as string[], unitPrice: [] as number[], count: [] as number[],
      price: [] as number[], reinforce: [] as number[], refine: [] as number[],
      amp: [] as (string | null)[], dupSeq: [] as number[],
    };
    for (const r of sold) {
      const soldDate = kstToIso(r.soldDate);
      const key = `${soldDate}|${r.unitPrice}|${r.count}|${r.reinforce}`;
      const seq = seqOf.get(key) ?? 0;
      seqOf.set(key, seq + 1);
      T.soldDate.push(soldDate); T.unitPrice.push(r.unitPrice); T.count.push(r.count);
      T.price.push(r.price); T.reinforce.push(r.reinforce); T.refine.push(r.refine);
      T.amp.push(r.amplificationName); T.dupSeq.push(seq);
    }

    // ── 2. 현재 매물 ────────────────────────────────────────────
    const listings = await getAuction(itemId, 400);
    const capped = listings.length >= 400;
    const observedAt = nowIso();

    const open = await query<{ auction_no: string; unit_price: number; cur_count: number; expire_date: Date }>(
      'SELECT auction_no, unit_price, cur_count, expire_date FROM listings WHERE item_id = $1 AND closed_at IS NULL',
      [itemId]);
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
      reinforce: [] as number[],
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
    }

    // 사라진 매물: 완판이거나 만료. 단 응답이 400건으로 잘렸다면
    // 잘려나간 고가 매물을 "사라졌다"고 오판하지 않도록 가격 상한 안쪽만 본다.
    const priceCeiling = capped ? Math.max(...listings.map((r) => r.unitPrice)) : Infinity;
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

    const prices = listings.map((r) => r.unitPrice).sort((a, b) => a - b);

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
        INSERT INTO listings (auction_no, item_id, reg_date, expire_date, unit_price, reg_count, cur_count, reinforce, first_seen_at, last_seen_at)
        SELECT u.auction_no, $1, u.reg_date, u.expire_date, u.unit_price, u.reg_count, u.cur_count, u.reinforce, $9, $9
        FROM UNNEST(
          $2::bigint[], $3::timestamptz[], $4::timestamptz[], $5::bigint[], $6::int[], $7::int[], $8::int[]
        ) AS u(auction_no, reg_date, expire_date, unit_price, reg_count, cur_count, reinforce)
        ON CONFLICT (auction_no) DO UPDATE SET
          cur_count = EXCLUDED.cur_count,
          unit_price = EXCLUDED.unit_price,
          last_seen_at = EXCLUDED.last_seen_at`,
        [itemId, L.auctionNo, L.regDate, L.expireDate, L.unitPrice, L.regCount, L.curCount, L.reinforce, observedAt]);

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

      await c.query(`
        INSERT INTO listing_snapshots (item_id, captured_at, min_unit_price, p10, p25, median, listing_count, total_qty)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [itemId, observedAt, prices[0] ?? null, quantile(prices, 0.1), quantile(prices, 0.25),
          quantile(prices, 0.5), listings.length, listings.reduce((s, r) => s + r.count, 0)]);

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
