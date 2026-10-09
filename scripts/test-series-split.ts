import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askGapPath, splitSeries } from '../src/series-split.ts';

// web/build.ts가 쓰는 시계열 한 건의 모양(필드 이름·중첩은 실제 배포 파일과 같다).
const gap = (t: string, gapValue: number) => ({ t, min_ask: 90, vwap: 100, gap: gapValue });
const series = () => ({
  completeBefore: '2026-10-09', forecastDay: '2026-10-09', priceBasis: 'trade',
  daily: [{ d: '2026-10-07', o: 1, h: 2, l: 1, c: 2, vwap: 1.5, qty: 10, n: 6 }],
  hourly: [{ t: '2026-10-08T01:00:00Z', vwap: 1.5, qty: 3 }],
  cleaning: [{ item_id: 'x', d: '2026-10-07', excluded_n: 0 }],
  distribution: {
    asOf: '2026-10-09T03:00:00Z', minTrades: 5,
    daily: [{ kind: 'day', d: '2026-10-07', t: '2026-10-07T00:00:00Z', q25: 1, median: 2, q75: 3, n: 6, qty: 10, l: 1, h: 3, vwap: 2 }],
    hourly: [{ kind: 'hour', d: '2026-10-07', t: '2026-10-07T01:00:00Z', q25: 1, median: 2, q75: 3, n: 5, qty: 5, l: 1, h: 3, vwap: 2 }],
  },
  askGap: [gap('2026-10-08T00:00:00Z', -0.1), gap('2026-10-08T00:05:00Z', 0.2)],
  stock: [{ observed_at: '2026-10-08T00:00:00Z', qty: 10, listings: 2, min_ask: 90 }],
  depth: [{ price: 90, qty: 4 }], events: [], max: null,
});

const { core, askGapFile } = splitSeries(series());
assert.equal('askGap' in core, false, '핵심 파일에서 askGap을 뺀다');
assert.deepEqual(askGapFile, { askGap: series().askGap }, '호가 차이 행은 한 줄도 바뀌지 않고 별도 파일로 간다');
assert.equal(core.askGapCount, 2, '별도 파일이 있다는 표시와 행 수');
assert.deepEqual(core.distribution, { asOf: '2026-10-09T03:00:00Z', minTrades: 5, daily: series().distribution.daily }, '일별 분위수·asOf·minTrades는 남고 hourly만 빠진다');

// 나머지 필드는 값도 순서도 그대로여야 한다(파이썬 예측·패키지 연구·일봉 기록 스크립트가 읽는다).
const original = series();
assert.deepEqual(Object.keys(core), [...Object.keys(original).filter((k) => k !== 'askGap'), 'askGapCount']);
for (const key of ['completeBefore', 'forecastDay', 'priceBasis', 'daily', 'hourly', 'cleaning', 'stock', 'depth', 'events', 'max'] as const) {
  assert.deepEqual(core[key], original[key], `${key} 그대로`);
}
// 외부 스크립트가 의존하는 필드가 핵심 파일에 있는지 한 번 더 못 박는다.
for (const need of ['completeBefore', 'forecastDay', 'daily', 'priceBasis']) assert(need in core, `${need}는 핵심 파일에 있어야 함`);
assert(core.distribution.asOf, 'build-inline-forecast.py가 distribution.asOf를 읽는다');

// 호가 차이가 없는 아이템(카드·신규): 파일을 만들지 않고 표시도 달지 않는다.
for (const empty of [[], undefined]) {
  const r = splitSeries({ ...series(), askGap: empty });
  assert.equal(r.askGapFile, null);
  assert.equal('askGapCount' in r.core, false);
  assert.equal('askGap' in r.core, false);
}
// 체결 기준이 아닌 아이템은 distribution이 null — 그대로 둔다.
assert.equal(splitSeries({ ...series(), distribution: null }).core.distribution, null);
assert.equal('distribution' in splitSeries({ daily: [] }).core, false, 'distribution 필드 자체가 없으면 만들지 않음');
// 입력을 바꾸지 않는다(빌드는 같은 객체를 다른 곳에도 쓴다).
const input = series(); splitSeries(input);
assert.deepEqual(input, series(), '입력 객체는 그대로');

// 프론트엔드(app.js)가 요청하는 파일 이름과 빌드가 쓰는 이름이 같아야 한다.
const app = readFileSync('web/app.js', 'utf8');
assert(app.includes('.askgap.json'), 'app.js가 호가 차이 파일을 요청한다');
assert.equal(askGapPath('abc'), 'abc.askgap.json');
assert(app.includes('data/series/${it.item_id}.askgap.json'), 'app.js의 요청 주소가 askGapPath와 같은 모양(data/series/<id>.askgap.json)');
// 빌드가 이 함수를 거쳐 파일을 쓴다.
const build = readFileSync('web/build.ts', 'utf8');
assert(build.includes('splitSeries(') && build.includes('askGapPath('), 'web/build.ts가 splitSeries·askGapPath를 쓴다');
console.log('시계열 분리: 핵심 파일 필드 보존·호가 차이 파일·hourly 제외·빈 값·입력 불변·요청 이름 일치 통과');
