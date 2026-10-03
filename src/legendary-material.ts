import type { AuctionRow } from './api.ts';

export type MaterialListing = { auctionNo: number; itemId: string; itemName: string; unitPrice: number; count: number };

// 같은 종류의 서로 다른 매물을 포함한다. 같은 경매 번호만 중복 제거한다.
export function cheapestMaterialListings(rows: AuctionRow[], cappedBoundaries: number[] = []): MaterialListing[] | null {
  const unique = new Map<number, MaterialListing>();
  for (const row of rows) {
    if (row.upgrade !== 0 || row.itemRarity !== '레전더리') continue;
    if (!Number.isSafeInteger(row.count) || row.count < 1 || !Number.isSafeInteger(row.auctionNo) || !Number.isSafeInteger(row.unitPrice) || row.unitPrice <= 0) return null;
    unique.set(row.auctionNo, { auctionNo: row.auctionNo, itemId: row.itemId,
      itemName: row.itemName, unitPrice: row.unitPrice, count: row.count });
  }
  const top = [...unique.values()].sort((a,b) => a.unitPrice-b.unitPrice || a.auctionNo-b.auctionNo).slice(0,10);
  // 400건 뒤에 더 싼 0업 매물이 숨을 수 있으면 10개를 확정하지 않는다.
  if (cappedBoundaries.some(price => top.length < 10 || !(price >= top[9].unitPrice))) return null;
  return top;
}

export function materialPrice(rows: MaterialListing[] | null | undefined) {
  return rows?.length === 10 ? rows.reduce((sum,row) => sum+row.unitPrice,0)/10 : null;
}
