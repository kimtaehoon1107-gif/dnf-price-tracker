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

export interface VarianceRatio {
  vr: number;
  z: number;
  p: number;
  returns: number;
}

/** 빈 시간을 메우거나 건너뛰지 않는다. 길이가 같으면 더 최근 구간을 선택한다. */
export function longestCompleteHours<T extends { t: string }>(rows: T[], asOf: number): T[] {
  const cutoff = Math.floor(asOf / 3_600_000) * 3_600_000;
  const complete = rows.filter((row) => Date.parse(row.t) < cutoff)
    .sort((a, b) => a.t.localeCompare(b.t));
  let longest: T[] = [], current: T[] = [];
  for (const row of complete) {
    if (current.length && Date.parse(row.t) - Date.parse(current.at(-1)!.t) !== 3_600_000) {
      current = [];
    }
    current.push(row);
    if (current.length >= longest.length) longest = current;
  }
  return longest;
}

/** Holm 보정은 종목 간 독립성을 가정하지 않고 한 번의 빌드 내 다중 검정을 보정한다. */
export function holmAdjusted(pValues: number[]): number[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = Array<number>(pValues.length);
  let previous = 0;
  order.forEach(({ p, i }, rank) => {
    previous = Math.max(previous, Math.min(1, p * (order.length - rank)));
    adjusted[i] = previous;
  });
  return adjusted;
}

/**
 * Lo–MacKinlay: 겹치는 수익률의 편향 보정 + 이분산 견고한 표준오차.
 * 입력은 반드시 같은 간격의 연속 가격이다. VR < 1은 단기 반전을 시사할 뿐,
 * 가격 수준의 평균회귀나 매수 전략의 수익성을 입증하지 않는다.
 * 대조 구현: https://bashtage.github.io/arch/_modules/arch/unitroot/unitroot.html#VarianceRatio
 */
export function varianceRatio(prices: number[], q = 2): VarianceRatio | null {
  const n = prices.length - 1;
  if (prices.length < 30 || !Number.isInteger(q) || q < 2 || q >= n
    || prices.some((p) => !(p > 0) || !Number.isFinite(p))) return null;
  const one = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = one.reduce((sum, r) => sum + r, 0) / n;
  const squares = one.map((r) => (r - mean) ** 2);
  const sumSquares = squares.reduce((sum, r) => sum + r, 0);
  if (sumSquares <= Number.EPSILON ** 2 * n) return null;
  let multiSquares = 0;
  for (let i = q; i < prices.length; i++) {
    multiSquares += (Math.log(prices[i] / prices[i - q]) - q * mean) ** 2;
  }
  const m = q * (n - q + 1) * (1 - q / n);
  const vr = (multiSquares / m) / (sumSquares / (n - 1));
  let theta = 0;
  for (let lag = 1; lag < q; lag++) {
    let cross = 0;
    for (let i = lag; i < n; i++) cross += squares[i] * squares[i - lag];
    theta += (2 * (1 - lag / q)) ** 2 * cross / sumSquares ** 2;
  }
  if (!(theta > 0)) return null;
  const z = (vr - 1) / Math.sqrt(theta);
  // 표준정규분포의 양측 확률. A&S 26.2.17, CDF 최대 오차 7.5e-8.
  const a = Math.abs(z), t = 1 / (1 + 0.2316419 * a);
  const tail = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI)
    * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return { vr, z, p: Math.min(1, 2 * tail), returns: n };
}

/** 카드 가격은 단계가 명시된 0업과 실제 최대 업그레이드 매물만 사용한다. */
export function selectCardListings<T extends { upgrade?: number | null }>(
  rows: T[],
  maxUpgrade: number | null,
): T[] {
  return rows.filter((row) => row.upgrade === 0
    || (maxUpgrade !== null && row.upgrade === maxUpgrade));
}
