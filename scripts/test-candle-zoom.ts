import assert from 'node:assert/strict';
import { candleZoom } from '../web/metrics.js';

const daily = [
  { d: '2026-09-21', o: 358450, h: 8300000, l: 300000, c: 357388, vwap: 356705.2936472042 },
  { d: '2026-09-25', o: 349800, h: 355723, l: 34990, c: 349990, vwap: 349488.4237744638 },
];
const original = structuredClone(daily);
const zoom = candleZoom(daily)!;
assert(zoom.max < 400000 && zoom.min > 300000, '830만 고가·3.5만 저가가 확대 범위를 늘리지 않음');
assert.equal(zoom.candles[0].high, zoom.max);
assert.equal(zoom.candles[1].low, zoom.min);
assert.equal(zoom.candles[0].open, daily[0].o);
assert.equal(zoom.candles[0].close, daily[0].c);
assert.equal(zoom.above.length, 1);
assert.equal(zoom.below.length, 2);
assert.deepEqual(daily, original, '툴팁·전체 범위에서 사용하는 원본은 불변');
const flat = candleZoom([{ d: '2026-09-21', o: 1, h: 1, l: 1, c: 1, vwap: 1 }])!;
assert(flat.min > 0 && flat.min < 1 && flat.max > 1, '고정 가격도 0이 아닌 표시 범위');
assert.equal(flat.above.length + flat.below.length, 0);
assert.equal(candleZoom([]), null);
console.log('candle zoom: 극단가·원본 보존·고정 가격 확인');
