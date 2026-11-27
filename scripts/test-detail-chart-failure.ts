import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as metrics from '../web/metrics.js';
import * as packageUI from '../web/package.js';
const nodes = new Map();
const node = (id) => {
  if (id === 'depth-plot') return null;
  if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, append() {} });
  return nodes.get(id);
};
let scriptStarted = false, distributionDraws = 0, failSeries = false;
let pendingSeries: (() => void)[] | null = null;
const seriesPanel = { hidden: false };
const upgradeButtons = ['zero', 'max'].map(cardMode => ({ dataset: { cardMode }, onclick() {} }));
const quantityButtons = [1, 10, 100].map(quantity => ({
  dataset: { quoteQty: String(quantity) }, pressed: 'false', onclick() {},
  setAttribute(_name: string, value: string) { this.pressed = value; },
}));
let snapshot = {};
const days = Array.from({length: 14}, (_, i) => ({
  d: new Date(Date.UTC(2026, 8, 23 + i)).toISOString().slice(0, 10), vwap: 120,
}));
const context = vm.createContext({ console: { ...console, error() {} }, Date, window: {}, location: {hash:'#sample'}, scrollTo() {},
  getComputedStyle: () => ({getPropertyValue: () => '#333333'}),
  document: {documentElement: {}, getElementById: node, querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '[data-detail-series]') return [seriesPanel];
      if (selector === '.upgrade-sw button') return upgradeButtons;
      if (selector === '[data-quote-qty]') return quantityButtons;
      return [];
    },
    createElement: () => ({remove() {}}), head: {append(script) {scriptStarted = true; script.onerror();}}},
  fetch: async () => { await Promise.resolve(); assert(scriptStarted, 'chart request starts before series finishes');
    if (pendingSeries) await new Promise<void>(resolve => pendingSeries!.push(resolve));
    if (failSeries) return { ok: false, status: 503 };
    return {ok:true,json:async()=>({daily:days,completeBefore:'2026-10-06',depth:[],hourly:[],...snapshot,stock:[{t:'2026-10-06T00:00:00Z',qty:10,listings:2}],askGap:[{t:'2026-10-06T00:00:00Z',gap:1}],events:[]})}; }
});
const source = readFileSync('web/app.js','utf8');
const module = new vm.SourceTextModule(source + '\nexport {render, renderDetail}; export function fixture(builtAt = "2026-10-07T00:00:00Z", items = []) { DATA = {builtAt, items}; }', { context, importModuleDynamically: async (specifier) => {
  assert(specifier.startsWith('./price-distribution.js'));
  const renderer = new vm.SyntheticModule(['renderPriceDistribution', 'disposePriceDistribution'], function () {
    this.setExport('renderPriceDistribution', () => { distributionDraws++; });
    this.setExport('disposePriceDistribution', () => {});
  }, { context });
  await renderer.link(() => assert.fail('Unexpected chart import'));
  await renderer.evaluate();
  return renderer;
} });
await module.link(name => {
 const exports = name.includes('summary-data') ? {loadSummary:()=>new Promise(()=>{})}
  : name.includes('forecast-review') ? {itemForecastPanel:()=>'',mountForecastReview:()=>{}}
  : name.includes('package.js') ? packageUI
  : metrics;
 return new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value)},{context});
});
await module.evaluate(); module.namespace.fixture();
const item = {item_id:'sample',item_name:'테스트',category:'소울 결정',price_basis:'trade',vwap24:100,span_days:30,last_price:90,last_trade_at:'2026-10-06T06:30:00Z'};
await module.namespace.renderDetail(item);
assert.equal(distributionDraws, 1);
assert.match(node('quantity-quote').innerHTML,/매물 수량을 확인하지 못했어요/);
assert.match(node('price-position').innerHTML,/현재 13일/, '집계 완료 전 날짜를 가격 비교에 포함하지 않는다');
assert.match(node('view').innerHTML,/마지막 거래가<\/div>\s*<div class="bigpx">90<small>골드/);
assert.match(node('view').innerHTML,/최근 1시간 거래 관측 없음<br>마지막 거래/);
assert.match(node('stock-chart').innerHTML,/차트를 불러오지 못했습니다/);
assert.match(node('c4').innerHTML,/차트를 불러오지 못했습니다/);
assert.match(node('view').innerHTML,/확인된 최저 매물가[\s\S]*수량별 구매가[\s\S]*가격 추이/);
failSeries = true;
await module.namespace.renderDetail(item);
assert.match(node('price-panel').innerHTML,/가격 추이를 불러오지 못했습니다/);
assert.match(node('view').innerHTML,/마지막 거래가/);
assert.match(node('quantity-quote').innerHTML,/수량별 구매가를 불러오지 못했어요/);
assert.equal(seriesPanel.hidden, true);
console.log('차트 요청 병렬 시작·CDN 및 시계열 요청 실패 시 가격 정보 유지 통과');

failSeries = false;
const observedAt = new Date().toISOString();
const quoteItem = { ...item, min_ask: 90, ask_observed_at: observedAt, gap: -10, api_qty24: 10, listings: 2 };
module.namespace.fixture(observedAt);
const levels = [{ price: 120, qty: 90 }, { price: 90, qty: 9 }, { price: 91, qty: 1 }];
snapshot = { depth: levels, depthObservedAt: observedAt };
await module.namespace.renderDetail(quoteItem);
assert.match(node('view').innerHTML, /10% 낮아요/);
const result = node('quantity-result');
assert.match(result.innerHTML, /구매 총액<\/dt><dd>90 /);
assert.match(node('quantity-quote').innerHTML, /매물 관측.*KST/);
assert.equal(quantityButtons[0].pressed, 'true');
quantityButtons[1].onclick();
assert.match(result.innerHTML, /구매 총액<\/dt><dd>901 /);
assert.match(result.innerHTML, /개당 평균<\/dt><dd>90\.1 /);
quantityButtons[2].onclick();
assert.match(result.innerHTML, /구매 총액<\/dt><dd>11,701 /);
assert.match(result.innerHTML, /개당 평균<\/dt><dd>117\.01 /);
assert.deepEqual(quantityButtons.map(button => button.pressed), ['false', 'false', 'true']);
assert.match(node('depth').innerHTML, /관측된 수량 100개/);

snapshot = { depth: levels.slice(1), depthObservedAt: observedAt };
await module.namespace.renderDetail(quoteItem);
quantityButtons[2].onclick();
assert.match(result.innerHTML, /100개 중 10개 확인/);
assert.doesNotMatch(result.innerHTML, /구매 총액|개당 평균/);

snapshot = { depth: levels, depthObservedAt: '2026-10-06T05:00:00Z' };
await module.namespace.renderDetail(quoteItem);
assert.match(node('quantity-quote').innerHTML, /같은 시각의 매물 수량을 확인하지 못했어요/);
assert.doesNotMatch(node('quantity-quote').innerHTML, /data-quote-qty/);
snapshot = { depth: levels, depthObservedAt: observedAt };
await module.namespace.renderDetail({ ...quoteItem, listings: 0 });
assert.match(node('quantity-quote').innerHTML, /관측된 매물이 없어요/);

pendingSeries = [];
snapshot = {};
const previousDraws = distributionDraws;
module.namespace.fixture(observedAt, [{ ...item, price_basis: 'ask0', category: '카드', max_upgrade: 2 }]);
module.namespace.render();
upgradeButtons[1].onclick();
upgradeButtons[0].onclick();
await Promise.resolve();
assert.equal(pendingSeries.length, 3);
pendingSeries[2]();
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(distributionDraws, previousDraws + 1, '마지막 0업 요청만 현재 차트를 그린다');
pendingSeries[0]();
pendingSeries[1]();
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(distributionDraws, previousDraws + 1, '늦게 완료된 0업·풀업 요청은 현재 차트를 덮지 않는다');
