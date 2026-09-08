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
  returns: number;
}

/**
 * 분산비 검정 (Lo–MacKinlay 1988).
 *
 * 랜덤워크라면 q기간 수익률의 분산은 1기간 분산의 정확히 q배다.
 *   VR(q) = Var(q기간) / (q × Var(1기간))
 *   VR = 1  랜덤워크    VR > 1  추세(모멘텀)    VR < 1  평균회귀
 *
 * z는 동분산 가정 아래의 표준화 통계량이다. 이분산에 견고한 형태가 따로 있지만,
 * 지금 표본(시간봉 30~90개)에서는 어느 쪽을 써도 결론이 갈릴 만큼 정밀하지 않다.
 * 그래서 z는 방향의 참고값으로만 쓰고, 판정은 겹치는 구간의 일관성으로 뒷받침한다.
 */
export function varianceRatio(prices: number[], q = 2): VarianceRatio | null {
  if (prices.length < 30 || prices.some((p) => !(p > 0))) return null;

  const one = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const variance = (xs: number[]) => {
    if (xs.length < 2) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  };
  const var1 = variance(one);
  if (var1 === null || var1 <= 0) return null;

  // q기간 수익률은 한 칸씩 겹쳐가며 만든다(overlapping). 표본이 얇을수록 이 편이 낫다.
  const multi: number[] = [];
  for (let i = 0; i + q < prices.length; i++) multi.push(Math.log(prices[i + q] / prices[i]));
  const varq = variance(multi);
  if (varq === null) return null;

  const vr = varq / (q * var1);
  const se = Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * one.length));
  return { vr, z: (vr - 1) / se, returns: one.length };
}

/** 카드 가격은 단계가 명시된 0업과 실제 최대 업그레이드 매물만 사용한다. */
export function selectCardListings<T extends { upgrade?: number | null }>(
  rows: T[],
  maxUpgrade: number | null,
): T[] {
  return rows.filter((row) => row.upgrade === 0
    || (maxUpgrade !== null && row.upgrade === maxUpgrade));
}
