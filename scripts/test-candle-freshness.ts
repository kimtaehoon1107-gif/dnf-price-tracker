import assert from 'node:assert/strict';
import { candleFreshness } from '../src/candle-check.ts';
const at = Date.parse('2026-09-09T00:00:00Z');
assert.equal(candleFreshness(new Date(at - 90 * 60000), at).stale, false);
assert.equal(candleFreshness(new Date(at - 90 * 60000 - 1), at).stale, true);
assert.equal(candleFreshness(null, at).stale, true);
assert.equal(candleFreshness('invalid', at).stale, true);
assert.equal(candleFreshness(new Date(at - 30 * 60000), at).ageMinutes, 30);
console.log('시간봉 집계 지연 경계 테스트 통과');
