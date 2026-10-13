import assert from 'node:assert/strict';
import { turnoverWindow } from '../src/build-game-day-turnover.ts';
assert.equal(turnoverWindow('2026-10-13T05:59:59+09:00').end, '2026-10-11T21:00:00.000Z');
assert.deepEqual(turnoverWindow('2026-10-13T06:00:00+09:00'), {
  start: '2026-09-12T21:00:00.000Z', end: '2026-10-12T21:00:00.000Z',
});
assert.equal(turnoverWindow('2026-10-13T23:00:00+09:00').end, '2026-10-12T21:00:00.000Z');
assert.throws(() => turnoverWindow('invalid'));
console.log('Game-day turnover: 06:00 boundary and completed-day window passed');
