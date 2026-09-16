import assert from 'node:assert/strict';
import { compareForecasts, summarizeComparison, type ComparisonCase } from '../src/forecast-comparison.ts';
import { rollingForecasts } from '../src/forecast.ts';

const history = Array.from({ length: 40 }, (_, i) => ({
  d: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10),
  vwap: 100 * Math.exp(0.01 * i) * (i % 7 === 3 ? 1.15 : 1), n: 10,
}));
const market = new Map([['target', history], ['peer', history.map((p) => ({ ...p, vwap: p.vwap * 2 }))]]);
const cases = compareForecasts(market, '2026-09-10');
const deployed = rollingForecasts(history, market);
assert.deepEqual(cases.filter((c) => c.itemId === 'target').map((c) => c.weekday), deployed.map((c) => c.mid));
assert(cases.some((c) => Math.abs(c.trend - c.weekday) > 0.01));
for (const c of cases) {
  assert.equal((Date.parse(c.d) - Date.parse(c.origin)) / 86400000, c.horizonDays);
  assert.equal(c.naive, market.get(c.itemId)!.filter((p) => p.d < c.origin).at(-1)!.vwap);
}

// 다른 종목을 포함해 미래의 가격·거래량을 바꿔도 과거 예측은 그대로여야 한다.
const cutoff = '2026-08-24';
const altered = new Map([...market].map(([id, days]) => [id,
  days.map((p) => p.d >= cutoff ? { ...p, vwap: p.vwap * 100, n: 0 } : p)]));
assert.deepEqual(compareForecasts(market, cutoff), compareForecasts(altered, cutoff));
const predictions = (rows: ComparisonCase[]) => rows.filter((c) => c.origin < cutoff)
  .map(({ actual, ...prediction }) => prediction);
assert.deepEqual(predictions(cases), predictions(compareForecasts(altered, '2026-09-10')));

// 이후 거래량이 낮아져도 과거의 적격 평가를 버리지 않고, 결측 목표일도 채우지 않는다.
const sparse = history.filter((p) => p.d !== '2026-08-25').map((p) => p.d >= cutoff ? { ...p, n: 1 } : p)
  .concat(Array.from({ length: 30 }, (_, i) => ({
    d: new Date(Date.UTC(2026, 8, i + 10)).toISOString().slice(0, 10), vwap: 150, n: 1,
  })));
assert(sparse.reduce((sum, p) => sum + p.n, 0) / sparse.length < 5);
const sparseCases = compareForecasts(new Map([['target', sparse]]), '2026-10-10');
assert(sparseCases.some((c) => c.origin < cutoff));
assert(!sparseCases.some((c) => c.d === '2026-08-25'));
assert.deepEqual(compareForecasts(new Map([['thin', history.map((p) => ({ ...p, n: 1 }))]]), '2026-09-10'), []);

// 요일 계수를 추정할 종목이 없는 짧은 이력은 추세만 모델과 같아야 한다.
const short = compareForecasts(new Map([['short', history.slice(0, 14)]]), '2026-09-10');
assert(short.length > 0);
assert(short.every((c) => c.trend === c.weekday));

// 사례 가중과 종목 동일 비중을 구분하고 요일 효과가 음수/양수인 경우를 모두 센다.
const row = { origin: '2026-08-20', d: '2026-08-21', horizonDays: 1, actual: 100 };
const summary = summarizeComparison([
  { ...row, itemId: 'a', naive: 110, trend: 120, weekday: 110 },
  ...Array.from({ length: 3 }, () => ({ ...row, itemId: 'b', naive: 100, trend: 100, weekday: 120 })),
]);
assert.equal(summary.caseWeightedMape.weekday, 17.5);
assert.equal(summary.itemWeightedMape.weekday, 15);
assert.deepEqual(summary.weekdayVsTrend, { better: 1, tied: 0, worse: 1 });
assert.equal(summarizeComparison([]).caseWeightedMape.naive, null);
console.log('예측 비교 동일 표본·미래 누출·결측·과거 자격·가중 방식 테스트 통과');
