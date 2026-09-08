import assert from 'node:assert/strict';
import { estimateWeekday, forecast, rollingForecasts, scoreForecasts } from '../src/forecast.ts';

const market = new Map();
const daily = Array.from({ length: 12 }, (_, i) => ({
  d: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10),
  vwap: 100 * Math.exp(i * 0.01), n: 10,
}));

const regular = forecast(daily, market, 7, '2026-08-15');
assert(regular);
assert.equal(regular.horizonDays, 7);
assert.equal(regular.points[0].d, '2026-08-16');
assert.equal(regular.points.at(-1)?.d, '2026-08-22');

// 3일이 비어도 기울기는 "관측 1회"가 아니라 실제 달력 1일 기준이어야 한다.
const gapped = daily.filter((_, i) => ![3, 4, 5].includes(i));
const gapForecast = forecast(gapped.concat([
  { d: '2026-08-13', vwap: 100 * Math.exp(12 * 0.01), n: 10 },
]), market, 1, '2026-08-14');
assert(gapForecast);
assert(Math.abs(gapForecast.points[0].mid - 100 * Math.exp(14 * 0.01)) < 0.01);

const stale = forecast(daily, market, 1, '2026-08-15');
const nextDay = forecast(daily, market, 1);
assert(stale && nextDay);
assert(stale.points[0].hi / stale.points[0].lo >= nextDay.points[0].hi / nextDay.points[0].lo);

assert.equal(forecast(daily.slice(0, 9), market), null);
assert.equal(forecast(daily.map((p) => ({ ...p, n: 1 })), market), null);

const history = Array.from({ length: 40 }, (_, i) => ({
  d: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10),
  vwap: 100 + i + 3 * Math.sin(i), n: 10,
}));
const panel = new Map([['target', history], ['peer', history.map((p) => ({ ...p, vwap: p.vwap * 2 }))]]);
const origin = '2026-08-24';
const changed = history.map((p) => p.d >= origin ? { ...p, vwap: p.vwap * 10, n: 1000 } : p);
// 다른 종목의 미래 자료를 바꿔도 과거 계수·점 예측·구간은 변하지 않는다.
const changedPanel = new Map([['target', changed], ['peer', changed]]);
assert.deepEqual(estimateWeekday(panel, origin), estimateWeekday(changedPanel, origin));
assert.deepEqual(forecast(history, panel, 7, origin), forecast(changed, changedPanel, 7, origin));
const truncatedPanel = new Map([...panel].map(([id, points]) => [id, points.filter((p) => p.d < origin)]));
assert.deepEqual(forecast(history, panel, 7, origin),
  forecast(history.filter((p) => p.d < origin), truncatedPanel, 7, origin));

const cases = rollingForecasts(history, panel);
assert(cases.some((c) => c.horizonDays === 1) && cases.some((c) => c.horizonDays === 7));
for (const c of cases) {
  assert.equal((Date.parse(c.d) - Date.parse(c.origin)) / 86400000, c.horizonDays);
  const expectedNaive = history.filter((p) => p.d < c.origin).at(-1)!.vwap;
  assert.equal(c.naive, expectedNaive);
}
const gapCases = rollingForecasts(history.filter((p) => p.d !== '2026-08-25'), panel);
assert(!gapCases.some((c) => c.d === '2026-08-25'));
assert.equal(gapCases.find((c) => c.origin === origin && c.horizonDays === 7)?.d, '2026-08-31');
const oldPredictions = (rows: typeof cases) => rows.filter((c) => c.origin < origin && c.d < origin);
assert.deepEqual(oldPredictions(cases), oldPredictions(rollingForecasts(changed, changedPanel)));

// 평가 건수로 가중한다. 종목별 개선율을 단순 평균한 값과는 다르다.
const scored = scoreForecasts([
  { origin, d: '2026-08-25', horizonDays: 1, mid: 110, lo: 90, hi: 120, naive: 120, actual: 100 },
  { origin, d: '2026-08-31', horizonDays: 7, mid: 160, lo: 150, hi: 190, naive: 200, actual: 200 },
]);
assert(Math.abs(scored.mape! - 15) < 1e-10);
assert.equal(scored.naiveMape, 10);
assert.equal(scored.coverage, 50);
assert.equal(scoreForecasts([]).count, 0);
console.log('forecast 테스트 통과');
