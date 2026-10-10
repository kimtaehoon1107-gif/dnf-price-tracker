import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as metrics from '../web/metrics.js';
import * as packageUI from '../web/package.js';

// 상세 화면의 "24시간 평균 거래가 대비" 패널: 호가 차이 행은 핵심 시계열 파일에서 빠져 별도 파일(<id>.askgap.json)로 간다.
// 새 형식에서는 패널이 화면 근처에 올 때 그 파일을 받고, 옛 형식(핵심 파일에 askGap 포함)은 그대로 쓴다.
const GAP_ROWS = [{ t: '2026-10-06T00:00:00Z', min_ask: 90, vwap: 100, gap: -10 }, { t: '2026-10-06T01:00:00Z', min_ask: 95, vwap: 100, gap: -5 }];
const core = (extra: object) => ({ daily: [], depth: [], hourly: [], stock: [{ t: '2026-10-06T00:00:00Z', qty: 10, listings: 2 }], events: [], ...extra });
const source = readFileSync('web/app.js', 'utf8');

async function run({ series, askGapResponse, observer, early }: { series: object; askGapResponse?: () => object; observer?: boolean; early?: { id: string; response: Promise<unknown> } }) {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (id === 'depth-plot') return null;
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, append() {}, closest: () => ({ panel: id }) });
    return nodes.get(id);
  };
  const calls: string[] = [], errors: unknown[] = [], observers: any[] = [];
  let scriptStarted = false;
  const context: Record<string, unknown> = {
    console: { ...console, error: (...a: unknown[]) => errors.push(a) }, Date, window: {}, location: { hash: '#sample' },
    getComputedStyle: () => ({ getPropertyValue: () => '#333333' }),
    document: { documentElement: {}, getElementById: node, querySelectorAll: () => [], createElement: () => ({ remove() {} }), head: { append(script: any) { scriptStarted = true; script.onerror(); } } },
    fetch: async (url: string) => {
      await Promise.resolve();
      calls.push(url);
      if (url.endsWith('.askgap.json')) { const body = askGapResponse?.() ?? { askGap: GAP_ROWS }; return 'status' in body ? { ok: false, status: (body as any).status } : { ok: true, json: async () => body }; }
      assert(scriptStarted, '차트 요청은 시계열 요청이 끝나기 전에 시작');
      return { ok: true, json: async () => series };
    },
  };
  if (observer) context.IntersectionObserver = class { cb: any; opts: any; disconnected = false; target: any;
    constructor(cb: any, opts: any) { this.cb = cb; this.opts = opts; observers.push(this); }
    observe(target: any) { this.target = target; } disconnect() { this.disconnected = true; }
    trigger(isIntersecting = true) { this.cb([{ isIntersecting }]); } };
  if (early) { early.response.catch(() => {}); context.__seriesRequest = early; } // index.html <head>가 미리 요청해 둔 시계열 파일(공유 링크로 상세에 바로 들어온 경우)
  vm.createContext(context);
  const module = new vm.SourceTextModule(source + '\nexport {renderDetail}; export function fixture() { DATA = {builtAt: "2026-10-07T00:00:00Z"}; }', { context });
  await module.link((name) => {
    const exports: Record<string, unknown> = name.includes('summary-data') ? { loadSummary: () => new Promise(() => {}) }
      : name.includes('forecast-review') ? { itemForecastPanel: () => '', mountForecastReview: () => {} }
      : name.includes('package.js') ? packageUI
      : name.includes('price-distribution') ? { renderPriceDistribution: () => {}, disposePriceDistribution: () => {} }
      : metrics;
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await module.evaluate(); (module.namespace as any).fixture();
  await (module.namespace as any).renderDetail({ item_id: 'sample', item_name: '테스트', category: '소울 결정', price_basis: 'trade', vwap24: 100, span_days: 30 });
  const gapCalls = () => calls.filter((u) => u.endsWith('.askgap.json'));
  return { calls, gapCalls, c4: () => node('c4').innerHTML as string, errors, observers };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ① 새 형식, 관찰자 없음(구형 브라우저): 곧바로 별도 파일을 한 번 받아 이어서 처리한다(여기서는 차트 라이브러리가 실패하는 환경).
{
  const r = await run({ series: core({ askGapCount: 2 }) });
  assert.deepEqual(r.gapCalls(), ['data/series/sample.askgap.json'], '별도 파일을 정확히 한 번, 올바른 주소로 요청');
  assert.match(r.c4(), /차트를 불러오지 못했습니다/, '받은 행으로 이어서 처리하고 차트 실패 안내까지 도달');
  assert.equal(r.errors.length, 0);
}
// ② 새 형식 + 관찰자: 화면 근처에 오기 전에는 받지 않고, 오면 한 번만 받는다.
{
  const r = await run({ series: core({ askGapCount: 2 }), observer: true });
  assert.equal(r.gapCalls().length, 0, '패널이 멀리 있으면 호가 차이 파일을 받지 않는다');
  assert.equal(r.observers.length, 1);
  assert.equal(r.observers[0].opts.rootMargin, '600px 0px', '600px 앞에서 미리 받기 시작');
  r.observers[0].trigger(false); await tick();
  assert.equal(r.gapCalls().length, 0, '화면 밖 알림에는 반응하지 않는다');
  r.observers[0].trigger(true); await tick(); await tick();
  assert.equal(r.gapCalls().length, 1, '가까워지면 받는다');
  assert.equal(r.observers[0].disconnected, true, '한 번 받은 뒤 관찰을 끝낸다');
  assert.match(r.c4(), /차트를 불러오지 못했습니다/);
}
// ③ 별도 파일 요청이 실패하면 패널에만 안내를 보이고 화면 나머지는 그대로다.
{
  const r = await run({ series: core({ askGapCount: 2 }), askGapResponse: () => ({ status: 404 }) });
  assert.match(r.c4(), /호가 차이 자료를 불러오지 못했습니다/, '실패 안내');
  assert.equal(r.errors.length, 1, '원인은 콘솔에 남긴다');
}
// ④ 호가 차이 행이 없는 아이템: 요청하지 않고 안내만 보인다.
for (const series of [core({}), core({ askGapCount: 0 })]) {
  const r = await run({ series });
  assert.equal(r.gapCalls().length, 0, '행이 없으면 파일을 요청하지 않는다');
  assert.match(r.c4(), /비교할 판매가와 직전 24시간 거래 데이터가 아직 없습니다/);
}
// ⑤ 옛 형식(핵심 파일에 askGap 포함): 별도 요청 없이 그대로 쓴다. 배포 직후 캐시에 남은 옛 파일과도 호환된다.
{
  const r = await run({ series: core({ askGap: GAP_ROWS }) });
  assert.equal(r.gapCalls().length, 0);
  assert.match(r.c4(), /차트를 불러오지 못했습니다/);
}
// ⑥ 공유 링크로 들어와 시계열 파일을 미리 요청해 둔 경우: 그 응답을 이어받아 화면을 그리고, 같은 파일을 다시 요청하지 않는다.
{
  const r = await run({ series: core({}), early: { id: 'sample', response: Promise.resolve({ ok: true, json: async () => core({ askGapCount: 2 }) }) } });
  assert.equal(r.calls.filter((u) => u === 'data/series/sample.json').length, 0, '미리 요청한 응답을 이어받으면 직접 요청하지 않는다');
  assert.deepEqual(r.gapCalls(), ['data/series/sample.askgap.json'], '이어받은 시계열로 호가 차이도 정상 처리');
  assert.equal(r.errors.length, 0);
}
// ⑦ 미리 한 요청이 실패하면 직접 한 번 다시 요청해 정상으로 그린다.
{
  const r = await run({ series: core({ askGapCount: 2 }), early: { id: 'sample', response: Promise.reject(new Error('network')) } });
  assert.equal(r.calls.filter((u) => u === 'data/series/sample.json').length, 1, '실패하면 직접 한 번 요청');
  assert.deepEqual(r.gapCalls(), ['data/series/sample.askgap.json']);
  assert.equal(r.errors.length, 0);
}
console.log('호가 차이 지연 로딩: 별도 파일 1회·화면 근처에서만·실패 안내·빈 값·옛 형식 호환 · 시계열 선요청 이어받기·실패 복구 통과');
