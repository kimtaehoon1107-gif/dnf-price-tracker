export interface SoldIdentity {
  soldDate: string;
  unitPrice: number;
  count: number;
  reinforce: number;
}

/** 같은 자연키가 응답 안에서 몇 번째인지 센다. 별개 체결을 중복으로 지우지 않기 위한 값이다. */
export function duplicateSequences(rows: SoldIdentity[]): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.soldDate}|${row.unitPrice}|${row.count}|${row.reinforce}`;
    const sequence = seen.get(key) ?? 0;
    seen.set(key, sequence + 1);
    return sequence;
  });
}

/** API 응답 100건이 직전 성공 수집 구간과 전혀 겹치지 않는지 판정한다. */
export function isSaturated(
  soldCount: number,
  soldLimit: number,
  oldestSoldAt: string | undefined,
  previousRunAt: string | null,
): boolean {
  return soldCount >= soldLimit
    && previousRunAt !== null
    && oldestSoldAt !== undefined
    && oldestSoldAt > previousRunAt;
}

/** 수집 공백이 아니라 현재 폴링 주기 자체가 거래 속도보다 느린 경우만 가려낸다. */
export function isTooFast(
  saturated: boolean,
  spanMinutes: number | null,
  pollIntervalSeconds: number,
): boolean {
  return saturated
    && spanMinutes !== null
    && spanMinutes > 0
    && spanMinutes < pollIntervalSeconds / 60 * 1.5;
}

/** 카드 가격은 단계가 명시된 0업과 실제 최대 업그레이드 매물만 사용한다. */
export function selectCardListings<T extends { upgrade?: number | null }>(
  rows: T[],
  maxUpgrade: number | null,
): T[] {
  return rows.filter((row) => row.upgrade === 0
    || (maxUpgrade !== null && row.upgrade === maxUpgrade));
}
