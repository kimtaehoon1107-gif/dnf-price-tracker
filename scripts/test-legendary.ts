import assert from 'node:assert/strict';
import { legendarySeries, type LegendarySnapshot } from '../src/legendary.ts';

const snapshot = (captured_at: string, p10 = 100, total_listings = 10): LegendarySnapshot => ({
  captured_at, p10, total_listings, min_unit_price: p10 * 0.9,
  min_item_name: '재료 카드', median: p10 * 1.5, scanned: 165, with_listings: 80,
});
const hour = 3600000, day = 24 * hour;
const empty = legendarySeries([], '2026-09-13T00:00:00Z');
assert.equal(empty.hourly.length, 0);
assert.equal(empty.weekday.ready, false);

const intraday = legendarySeries([
  snapshot('2026-09-08T14:10:00Z', 50, 8),
  snapshot('2026-09-08T14:55:00Z', 100, 0),
  snapshot('2026-09-08T15:05:00Z', 300, 20),
  { ...snapshot('2026-09-08T16:05:00Z'), p10: null },
  snapshot('2026-09-10T00:00:00Z'),
], '2026-09-09T00:00:00Z');
assert.equal(intraday.observations, 3, '가격 없는 행과 미래 관측은 제외');
assert.equal(intraday.hourly.length, 2, '시간 안의 마지막 관측만 유지');
assert.equal(intraday.hourly[0].total_listings, 0, '실제 0건은 보존하고 매물을 합산하지 않음');
assert.deepEqual(intraday.daily.map((row) => row.d), ['2026-09-08', '2026-09-09'], 'KST 날짜 경계');
assert.equal(intraday.weekday.eligibleDays, 0, '당일과 18시간 미만 관측일 제외');

const average = legendarySeries([
  snapshot('2026-09-07T22:01:00Z', 50),
  snapshot('2026-09-07T22:55:00Z', 100),
  snapshot('2026-09-07T23:05:00Z', 300),
], '2026-09-09T00:00:00Z');
assert.equal(average.daily[0].p10, 200, '관측 횟수가 아닌 시간에 같은 비중');

// 주마다 가격 수준이 달라도 요일 패턴이 없는 자료는 모든 요일이 100이다.
const monday = Date.parse('2026-08-03T00:00:00+09:00');
const history = Array.from({ length: 28 * 18 }, (_, index) => {
  const d = Math.floor(index / 18), h = index % 18;
  return snapshot(new Date(monday + d * day + h * hour).toISOString(), 100 * (1 + Math.floor(d / 7)));
});
const asOf = new Date(monday + 28 * day).toISOString();
const ready = legendarySeries(history, asOf);
assert.equal(ready.weekday.ready, true);
assert.equal(ready.weekday.weeks, 4);
assert(ready.weekday.points.every((point) => point.n === 4 && point.price === 100));
assert.equal(ready.weekday.points[0].changeN, 3, '첫 월요일의 전날 자료를 만들어내지 않음');
assert.equal(legendarySeries(history, new Date(monday + 27 * day + 23 * hour).toISOString()).weekday.ready,
  false, '마지막 일요일이 아직 당일이면 4주로 계산하지 않음');

const missingHour = history.filter((_, index) => index !== 3 * 18);
assert.equal(legendarySeries(missingHour, asOf).weekday.weeks, 3, '17시간 관측한 목요일이 있으면 해당 주 제외');
const thursday = history.map((row, index) => Math.floor(index / 18) % 7 === 3
  ? { ...row, p10: row.p10! * 1.1 } : row);
const pattern = legendarySeries(thursday, asOf).weekday.points;
assert(Math.abs(pattern[3].price! - 110 / (710 / 7) * 100) < 1e-9, '목요일 가격 패턴 보존');
assert(Math.abs(pattern[3].change! - 10) < 1e-9, '목요일 전날 대비 변화율');
assert.equal(legendarySeries(history.slice(18), asOf).weekday.weeks, 3, '중간 요일부터 시작한 주 제외');
console.log('레전더리 시계열·요일 표본 테스트 통과');
