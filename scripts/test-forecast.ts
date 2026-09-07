import assert from 'node:assert/strict';
import { forecast } from '../src/forecast.ts';

const dow = new Map<number, number>();
const daily = Array.from({ length: 12 }, (_, i) => ({
  d: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10),
  vwap: 100 * Math.exp(i * 0.01),
}));

const regular = forecast(daily, dow, 7, '2026-08-15');
assert(regular);
assert.equal(regular.points[0].d, '2026-08-16');
assert.equal(regular.points.at(-1)?.d, '2026-08-22');

// 3일이 비어도 기울기는 "관측 1회"가 아니라 실제 달력 1일 기준이어야 한다.
const gapped = daily.filter((_, i) => ![3, 4, 5].includes(i));
const gapForecast = forecast(gapped.concat([
  { d: '2026-08-13', vwap: 100 * Math.exp(12 * 0.01) },
]), dow, 1);
assert(gapForecast);
assert(Math.abs(gapForecast.points[0].mid - 100 * Math.exp(13 * 0.01)) < 0.01);

const stale = forecast(daily, dow, 1, '2026-08-15');
const nextDay = forecast(daily, dow, 1);
assert(stale && nextDay);
assert(stale.points[0].hi / stale.points[0].lo >= nextDay.points[0].hi / nextDay.points[0].lo);

assert.equal(forecast(daily.slice(0, 9), dow), null);
console.log('forecast 테스트 통과');
