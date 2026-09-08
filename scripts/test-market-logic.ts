import assert from 'node:assert/strict';
import {
  duplicateSequences,
  isSaturated,
  isTooFast,
  selectCardListings,
  varianceRatio,
} from '../src/market-logic.ts';
import { askGap } from '../web/metrics.js';

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

console.log('시장 로직 테스트 통과');
