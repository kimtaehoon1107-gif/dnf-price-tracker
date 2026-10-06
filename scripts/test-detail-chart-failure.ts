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
let scriptStarted = false, distributionRendered = false;
const context = vm.createContext({ console, Date, window: {}, location: {hash:'#sample'},
  getComputedStyle: () => ({getPropertyValue: () => '#333333'}),
  document: {documentElement: {}, getElementById: node, querySelectorAll: () => [],
    createElement: () => ({remove() {}}), head: {append(script) {scriptStarted = true; script.onerror();}}},
  fetch: async () => { await Promise.resolve(); assert(scriptStarted, 'chart request starts before series finishes');
    return {ok:true,json:async()=>({daily:[],depth:[],hourly:[],stock:[{t:'2026-10-06T00:00:00Z',qty:10,listings:2}],askGap:[{t:'2026-10-06T00:00:00Z',gap:1}],events:[]})}; }
});
const source = readFileSync('web/app.js','utf8');
const module = new vm.SourceTextModule(source + '\nexport {renderDetail}; export function fixture() { DATA = {builtAt: "2026-10-07T00:00:00Z"}; }', {context});
await module.link(name => {
 const exports = name.includes('summary-data') ? {loadSummary:()=>new Promise(()=>{})}
  : name.includes('forecast-review') ? {itemForecastPanel:()=>'',mountForecastReview:()=>{}}
  : name.includes('package.js') ? packageUI
  : name.includes('price-distribution') ? {renderPriceDistribution:()=>{distributionRendered=true},disposePriceDistribution:()=>{}}
  : name.includes('comparison.js') ? {renderComparison:()=>{},disposeComparison:()=>{}} : metrics;
 return new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value)},{context});
});
await module.evaluate(); module.namespace.fixture();
await module.namespace.renderDetail({item_id:'sample',item_name:'테스트',category:'소울 결정',price_basis:'trade',vwap24:100,span_days:30});
assert(distributionRendered);
assert.match(node('depth').innerHTML,/현재 열린 매물이 없습니다/);
assert.match(node('price-position').innerHTML,/관측일/);
assert.match(node('stock-chart').innerHTML,/차트를 불러오지 못했습니다/);
assert.match(node('c4').innerHTML,/차트를 불러오지 못했습니다/);
assert.match(node('view').innerHTML,/구매 수량별 매물 가격/);
console.log('차트 요청 병렬 시작·CDN 실패 시 독립 정보 유지 통과');
