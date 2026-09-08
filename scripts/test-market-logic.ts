import assert from 'node:assert/strict';
import {
  duplicateSequences,
  isSaturated,
  isTooFast,
  selectCardListings,
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

console.log('시장 로직 테스트 통과');
