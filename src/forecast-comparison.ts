import { rollingForecasts, type Market } from './forecast.ts';

export const MODELS = ['naive', 'trend', 'weekday'] as const;
export type Model = typeof MODELS[number];
export interface ComparisonCase {
  itemId: string; origin: string; d: string; horizonDays: number;
  actual: number; naive: number; trend: number; weekday: number;
}

/** 같은 예측 코드에 빈 요일 계수용 시장을 주어, 요일 보정만 제거한다. */
export function compareForecasts(market: Market, before: string): ComparisonCase[] {
  const complete = new Map([...market].map(([id, days]) =>
    [id, days.filter((p) => p.d < before)]));
  const cases: ComparisonCase[] = [];
  for (const [itemId, days] of complete) {
    const weekday = rollingForecasts(days, complete);
    const trend = rollingForecasts(days, new Map());
    if (weekday.length !== trend.length) throw new Error('모델별 평가 표본이 다릅니다.');
    weekday.forEach((row, i) => {
      const plain = trend[i];
      if (row.origin !== plain.origin || row.d !== plain.d || row.horizonDays !== plain.horizonDays
        || row.actual !== plain.actual || row.naive !== plain.naive) {
        throw new Error('모델별 평가 시점이 다릅니다.');
      }
      cases.push({ itemId, origin: row.origin, d: row.d, horizonDays: row.horizonDays,
        actual: row.actual, naive: row.naive, trend: plain.mid, weekday: row.mid });
    });
  }
  return cases;
}

export function summarizeComparison(cases: ComparisonCase[]) {
  const ids = [...new Set(cases.map((c) => c.itemId))];
  const mape = (rows: ComparisonCase[], model: Model) => rows.length
    ? rows.reduce((sum, c) => sum + Math.abs(c[model] - c.actual) / c.actual * 100, 0) / rows.length
    : null;
  const perItem = ids.map((itemId) => {
    const rows = cases.filter((c) => c.itemId === itemId);
    return { itemId, count: rows.length,
      mape: Object.fromEntries(MODELS.map((m) => [m, mape(rows, m)!])) as Record<Model, number> };
  });
  return {
    count: cases.length, items: ids.length,
    origins: [...new Set(cases.map((c) => c.origin))].sort(),
    targets: [...new Set(cases.map((c) => c.d))].sort(),
    caseWeightedMape: Object.fromEntries(MODELS.map((m) => [m, mape(cases, m)])),
    itemWeightedMape: Object.fromEntries(MODELS.map((m) => [m,
      perItem.length ? perItem.reduce((sum, item) => sum + item.mape[m], 0) / perItem.length : null])),
    weekdayVsTrend: {
      better: perItem.filter((item) => item.mape.weekday < item.mape.trend - 1e-9).length,
      tied: perItem.filter((item) => Math.abs(item.mape.weekday - item.mape.trend) <= 1e-9).length,
      worse: perItem.filter((item) => item.mape.weekday > item.mape.trend + 1e-9).length,
    },
    perItem,
  };
}
