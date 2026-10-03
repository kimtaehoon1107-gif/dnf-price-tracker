import { cheapestMaterialListings, materialPrice } from '../src/legendary-material.ts';
import type { AuctionRow } from '../src/api.ts';
import { distributionRows } from '../web/price-distribution.js';
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

// 종류별 하나가 아니라 경매 매물별로 10개를 고른다.
const offers = Array.from({ length: 12 }, (_, i) => ({ auctionNo: i + 1,
  itemId: 'same-card', itemName: '같은 카드', itemRarity: '레전더리', count: 1,
  upgrade: 0, unitPrice: 100 + i } as AuctionRow));
const selected = cheapestMaterialListings([...offers].reverse().concat(offers[0],
  { ...offers[0], auctionNo: 99, upgrade: 2, unitPrice: 1 }))!;
assert.deepEqual(selected.map(row => row.auctionNo), [1,2,3,4,5,6,7,8,9,10]);
assert.equal(materialPrice(selected), 104.5);
assert.equal(materialPrice(selected.slice(0,9)), null, '10개 미만은 10개 평균으로 표시하지 않음');
assert.equal(cheapestMaterialListings(offers, [108]), null, '응답 경계 뒤 더 싼 매물이 가능하면 발행 보류');
assert.equal(cheapestMaterialListings(offers, [109])?.length, 10, '경계가 10번째 이상이면 가격 확인 가능');
assert.equal(cheapestMaterialListings(offers.slice(0,9), [500]), null);
const mixed = legendarySeries([
  snapshot('2026-09-08T01:00:00Z'),
  { ...snapshot('2026-09-08T02:00:00Z'), cheapest10: selected },
  { ...snapshot('2026-09-08T02:30:00Z'), cheapest10: selected.map(r => ({...r, unitPrice:r.unitPrice*2})) },
  { ...snapshot('2026-09-08T03:00:00Z'), cheapest10: selected },
], '2026-09-09T00:00:00Z');
assert.equal(mixed.hourly[0].mean10, null, '과거 P10으로 새 평균을 만들지 않음');
assert.equal(mixed.daily[0].mean10, 156.75, '새 지표도 시간별 마지막 관측의 평균');
assert.equal(mixed.daily[0].materialHours, 2);
assert.equal(mixed.daily[0].p10, 100, '기존 연구 P10은 불변');
const materialChart = distributionRows({basis:'legendary', asOf:mixed.asOf,
  daily:mixed.daily.map(r=>({...r,hours:r.materialHours,vwap:r.mean10}))});
assert.equal(materialChart[0].state, 'sparse', '구형 관측 시간을 새 지표의 관측 시간에 더하지 않음');
console.log('싼 매물 10개: 같은 카드·중복·업그레이드·응답 상한·과거 지표 분리 통과');
