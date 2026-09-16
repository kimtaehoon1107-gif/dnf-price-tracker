import assert from 'node:assert/strict';
import { basketSeries, eventWindow, issueForecast, scoreIssues, shiftDay, type Basket } from '../src/research.ts';

const basket: Basket = { id: 'a', label: '테스트', basis: 'trade', baseDate: '2026-08-01',
  members: [{ id: 'small', name: '저가', base: 10 }, { id: 'large', name: '고가', base: 1000 }] };
const index = basketSeries(basket, new Map([
  ['small', [{ d: '2026-08-01', value: 20 }, { d: '2026-08-02', value: 10 }]],
  ['large', [{ d: '2026-08-01', value: 1000 }]],
]));
assert.equal(index[0].value, 150, '가격대와 무관하게 구성종목별 비중 동일');
assert.equal(index[1].value, null, '결측 종목을 제외해 지수 비중을 바꾸지 않음');
assert.equal(index[1].coverage, 1);

const start = '2026-07-01', origin = shiftDay(start, 56);
const rows = Array.from({ length: 70 }, (_, i) => {
  const d = shiftDay(start, i), dow = new Date(d).getUTCDay();
  return { d, value: Math.exp(4 + i * .002 + (dow === 4 ? -.1 : 0)) };
});
const issue = issueForecast('test', rows, origin);
assert.equal(issue.train.length, 56);
assert.equal(issue.predictions.length, 21);
for (const p of issue.predictions.filter((p) => p.model === 'weekday')) {
  assert(Math.abs(p.value / rows.find((r) => r.d === p.d)!.value - 1) < 1e-9, '추세와 목요일 계수를 동시에 회복');
}
assert.equal(issue.predictions.find((p) => p.model === 'seasonal' && p.h === 7)?.value,
  rows.find((r) => r.d === shiftDay(origin, -7))!.value, '7일 뒤는 발행일 값을 미리 쓰지 않음');
assert.deepEqual(issueForecast('test', rows.map((r) => r.d >= origin ? { ...r, value: 1e12 } : r), origin), issue,
  '발행일과 미래 관측은 학습·자격·예측 어디에도 유입되지 않음');
assert.equal(issueForecast('test', rows.filter((r) => r.d !== shiftDay(origin, -1)), origin).predictions.length, 0,
  '전날이 없으면 발행 보류');
const short = issueForecast('test', rows.slice(49, 56), origin);
assert(!short.predictions.some((p) => p.model === 'weekday'), '요일 1회 관측을 학습 근거로 삼지 않음');
const missingSeason = issueForecast('test', rows.filter((r) => r.d !== shiftDay(origin, -6)), origin);
assert(!missingSeason.predictions.some((p) => p.model === 'seasonal' && p.h === 1), '지난주 같은 요일 결측을 다른 날로 대체하지 않음');

const actuals = new Map([[shiftDay(origin, 1), 100], [shiftDay(origin, 7), null]]);
const scores = scoreIssues([issue, { ...issue, predictions: issue.predictions.filter((p) => p.model !== 'weekday') }], actuals);
assert.equal(scores.find((s) => s.h === 1 && s.model === 'weekday')!.n, 1, '모델별 같은 평가 사례만 비교');
assert.equal(scores.find((s) => s.h === 1 && s.model === 'naive')!.n, 2);
assert.equal(scores.find((s) => s.h === 7)!.n, 0, '관측이 없으면 오차 0으로 계산하지 않음');
const e = eventWindow(rows, shiftDay(start, 14), shiftDay(start, 40));
assert.equal(e.ready, true);
assert.equal(eventWindow(rows.filter((r) => r.d !== shiftDay(start, 10)), shiftDay(start, 14), shiftDay(start, 40)).ready, false,
  '7일 전후 중 한 날짜가 빠지면 더 오래된 날짜로 대체하지 않음');
assert.equal(eventWindow(rows, shiftDay(start, 14), shiftDay(start, 20)).ready, false, '종료되지 않은 사건 후 기간 제외');
assert.equal(eventWindow(rows, shiftDay(start, -20), origin).preN, 0, '관측 전 출시를 임의로 복원하지 않음');
console.log('고정 지수·미래 누출·사전 예측 평가·이벤트 달력 구간 테스트 통과');
