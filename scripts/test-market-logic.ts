import assert from 'node:assert/strict';
import {
  duplicateSequences,
  isSaturated,
  isTooFast,
  longestCompleteHours,
  holmAdjusted,
  selectCardListings,
  varianceRatio,
} from '../src/market-logic.ts';
import { askGap, representativePrice } from '../web/metrics.js';

const same = { soldDate: '2026-09-08T00:00:00Z', unitPrice: 100, count: 3, reinforce: 0 };
assert.deepEqual(duplicateSequences([
  same,
  same,
  { ...same, unitPrice: 101 },
  same,
]), [0, 1, 0, 2]);

assert.equal(isSaturated(100, 100, '2026-09-08T00:01:00Z', '2026-09-08T00:00:00Z'), true);
assert.equal(isSaturated(99, 100, '2026-09-08T00:01:00Z', '2026-09-08T00:00:00Z'), false);
assert.equal(isSaturated(100, 100, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'), false);
assert.equal(isSaturated(100, 100, '2026-09-08T00:01:00Z', null), false);

assert.equal(isTooFast(true, 14.9, 600), true);
assert.equal(isTooFast(true, 15, 600), false);
assert.equal(isTooFast(true, null, 600), false);
assert.equal(isTooFast(false, 1, 600), false);

const cards = [{ upgrade: 0 }, { upgrade: 1 }, { upgrade: 2 }, { upgrade: null }];
assert.deepEqual(selectCardListings(cards, 2), [cards[0], cards[2]]);
assert.deepEqual(selectCardListings(cards, null), [cards[0]]);

assert(Math.abs(askGap({ price_basis: 'trade', min_ask: 90, vwap24: 100 }) + 10) < 1e-10);
assert.equal(askGap({ price_basis: 'ask0', min_ask: 90, vwap24: 100 }), null);
assert.equal(askGap({ price_basis: 'trade', min_ask: null, vwap24: 100 }), null);
assert.equal(representativePrice({ price_basis: 'trade', vwap1h: 125, last_price: 130 }), 125);
assert.equal(representativePrice({ price_basis: 'trade', vwap1h: null, last_price: 130 }), null);
assert.equal(representativePrice({ price_basis: 'ask0', vwap1h: null, last_price: 100 }), 100);

// ── 분산비 ──
// 완전한 랜덤워크를 넣으면 VR이 1 근처여야 한다. 난수 시드를 고정해 재현 가능하게 만든다.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const walk = [100];
for (let i = 0; i < 4000; i++) walk.push(walk.at(-1)! * Math.exp((rand() - 0.5) * 0.02));
const rw = varianceRatio(walk)!;
assert(Math.abs(rw.vr - 1) < 0.1, `랜덤워크 VR이 1에서 멀다: ${rw.vr}`);

// 매번 방향이 뒤집히는 계열은 극단적 평균회귀라 VR이 1보다 뚜렷하게 작아야 한다.
const zigzag = Array.from({ length: 200 }, (_, i) => 100 * (i % 2 === 0 ? 1 : 1.05));
assert(varianceRatio(zigzag)!.vr < 0.5);

// 모멘텀은 "값이 계속 오르는 것"이 아니라 "수익률이 양의 자기상관을 갖는 것"이다.
// 한 방향으로만 가는 지수 추세는 로그 수익률이 일정해 분산이 0이라 검정 자체가 안 된다.
let prev = 0;
const momentum = [100];
for (let i = 0; i < 2000; i++) {
  prev = 0.7 * prev + (rand() - 0.5) * 0.02;
  momentum.push(momentum.at(-1)! * Math.exp(prev));
}
assert(varianceRatio(momentum)!.vr > 1);

assert.equal(varianceRatio([1, 2, 3]), null);            // 표본 부족
assert.equal(varianceRatio(Array(50).fill(100)), null);  // 분산 0

// 30개가 넘어도 중간의 공백을 가로질러 하나의 시계열로 만들지 않는다.
const hour = (i: number) => ({ t: new Date(Date.UTC(2026, 8, 8, i)).toISOString() });
const interrupted = [...Array.from({ length: 20 }, (_, i) => hour(i)),
  ...Array.from({ length: 20 }, (_, i) => hour(i + 25))];
const segment = longestCompleteHours(interrupted, Date.UTC(2026, 8, 11));
assert.equal(segment.length, 20);
assert.equal(segment[0].t, hour(25).t); // 같은 길이면 최신 구간
assert.equal(longestCompleteHours([hour(0), hour(1), hour(2)], Date.UTC(2026, 8, 8, 2, 30)).length, 2);
assert.deepEqual(longestCompleteHours([], Date.now()), []);
assert.deepEqual(holmAdjusted([0.04, 0.001, 0.03]), [0.06, 0.003, 0.06]);
assert.deepEqual(holmAdjusted([0.6, 0.8]), [1, 1]);
assert.deepEqual(holmAdjusted([]), []);

// 손으로 검산할 수 있는 기준: 로그수익률 [0.01,-0.02,0.01,0]을 10회 반복.
// n=40, 1기간 제곱합=.006, 2기간=.0039, m=2*39*(1-2/40).
const reference = [100];
for (let i = 0; i < 40; i++) reference.push(reference.at(-1)! * Math.exp([0.01, -0.02, 0.01, 0][i % 4]));
const checked = varianceRatio(reference)!;
const expectedVR = (0.0039 / (2 * 39 * 0.95)) / (0.006 / 39);
const expectedZ = (expectedVR - 1) / Math.sqrt(0.0000008 / 0.006 ** 2);
assert(Math.abs(checked.vr - expectedVR) < 1e-10);
assert(Math.abs(checked.z - expectedZ) < 1e-10);
assert(checked.p < 0.001);

// 가격 자체는 랜덤워크지만 변동성이 중간에 크게 달라지는 계열도 확인한다.
const changingVariance = [100];
for (let i = 0; i < 4000; i++) changingVariance.push(changingVariance.at(-1)! * Math.exp((rand() - 0.5) * (i < 2000 ? 0.01 : 0.08)));
assert(Math.abs(varianceRatio(changingVariance)!.vr - 1) < 0.1);
assert.equal(varianceRatio(walk, 1), null);
assert.equal(varianceRatio([...walk.slice(0, 30), Infinity]), null);

console.log('시장 로직 테스트 통과');
