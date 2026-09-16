import assert from 'node:assert/strict';
import { cardWeekday, type CardWeekdayDay } from '../src/card-weekday.ts';

const monday = Date.parse('2026-08-03T00:00:00Z');
const DAY = 86400000;
const history = (item_id: string, basis: CardWeekdayDay['basis'], scale = 1, weeks = 4, thursday = 1): CardWeekdayDay[] =>
  Array.from({ length: weeks * 7 }, (_, index) => ({
    item_id, basis, d: new Date(monday + index * DAY).toISOString().slice(0, 10), hours: 18,
    price: scale * (1 + Math.floor(index / 7)) * (index % 7 === 3 ? thursday : 1),
  }));
const asOf = '2026-09-08T00:00:00Z';
const zero = (days: CardWeekdayDay[], ids = ['cheap', 'expensive']) => cardWeekday(days, ids, asOf).groups[0];
const empty = zero([]);
assert.equal(empty.eligibleItems, 0);
assert.equal(empty.thursdayPct, null, '기록 없음은 0%가 아님');

const flat = zero([...history('cheap', 'ask0'), ...history('expensive', 'ask0', 1000000)]);
assert.equal(flat.eligibleItems, 2);
assert(flat.points.every(point => point.price === 100), '가격대·주별 가격 수준이 달라도 요일 차이가 없으면 100');

const mixed = cardWeekday([
  ...history('cheap', 'ask0', 1, 4, 1.1),
  ...history('expensive', 'ask0', 1000000, 4, 1.1),
  ...history('cheap', 'askMax', 10, 4, 0.9),
], ['cheap', 'expensive', 'cheap'], asOf);
assert.equal(mixed.groups[0].candidates, 2, '후보 중복 방지');
assert(Math.abs(mixed.groups[0].thursdayPct! - (1.1 / (7.1 / 7) * 100 - 100)) < 1e-9);
assert(mixed.groups[1].thursdayPct! < 0, '0업과 맥스업 가격 패턴을 혼합하지 않음');
assert.equal(mixed.groups[1].eligibleItems, 1, '없는 맥스업을 0업으로 대체하지 않음');

const short = zero(history('cheap', 'ask0', 1, 3));
assert.equal(short.maxWeeks, 3);
assert.equal(short.thursdayPct, null);
const sparse = history('cheap', 'ask0');
sparse[3].hours = 17;
assert.equal(zero(sparse).maxWeeks, 3, '관측 부족 목요일이 있는 주는 제외');
assert.equal(zero(history('cheap', 'ask0').slice(1)).maxWeeks, 3, '월요일이 없는 주를 보충하지 않음');
assert.equal(cardWeekday(history('cheap', 'ask0'), ['cheap'], '2026-08-30T14:59:00Z').groups[0].maxWeeks, 3);
assert.equal(cardWeekday(history('cheap', 'ask0'), ['cheap'], '2026-08-30T15:00:00Z').groups[0].maxWeeks, 4, 'KST 일요일 완료 경계');

const weighted = zero([...history('cheap', 'ask0', 1, 4, 1.1), ...history('expensive', 'ask0', 1000, 5)]);
assert(Math.abs(weighted.thursdayPct! - mixed.groups[0].thursdayPct! / 2) < 1e-9, '긴 이력의 종목에 더 큰 비중을 주지 않음');
assert.equal(zero([...history('ignored', 'ask0'), ...history('cheap', 'ask0', 0)]).eligibleItems, 0, '비추적 종목·가격 없는 날 제외');

console.log('카드 요일 단계 분리·주별 정규화·동일 종목 비중·표본 경계 테스트 통과');
