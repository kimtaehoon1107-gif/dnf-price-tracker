import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as metrics from '../web/metrics.js';
import * as packageUI from '../web/package.js';

const elements = new Map<string, { textContent: string; stale: boolean; classList: { toggle: Function } }>();
for (const id of ['data-asof', 'data-freshness']) {
  const element = { textContent: '', stale: false, classList: { toggle(_name: string, value: boolean) { element.stale = value; } } };
  elements.set(id, element);
}
const context = vm.createContext({
  console, Date, document: { getElementById: (id: string) => id === 'view' ? view : elements.get(id), querySelectorAll: () => [] },
  location: { hash: '#other-item' },
  fetch: (url: string) => url.startsWith('data/series/')
    ? Promise.resolve({ ok: true, json: async () => ({}) }) : new Promise(() => {}),
});
const view = { innerHTML: '' };
const module = new vm.SourceTextModule(readFileSync('web/app.js', 'utf8') +
  '\nexport {renderDataStatus, renderDetail}; export function fixture(data, mode = "zero") { DATA = data; cardMode = mode; }', { context });
await module.link((name) => {
  const exports = name.includes('package.js') ? packageUI : metrics;
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
const now = Date.parse('2026-09-14T06:00:00Z');
const iso = (minutes: number) => new Date(now - minutes * 60000).toISOString();
const notice = elements.get('data-freshness')!;

// 페이지 생성 시각이 새로워도 오래된 수집 기록을 정상으로 표시하지 않는다.
module.namespace.fixture({ builtAt: iso(0), priceAsOf: iso(5), collection: { last_success: iso(179) } });
module.namespace.renderDataStatus(now);
assert.equal(notice.stale, false);
module.namespace.renderDataStatus(now + 60000);
assert.equal(notice.stale, true, '열어 둔 화면에서도 3시간 경계에 도달하면 경고');
assert.match(elements.get('data-asof')!.textContent, /⚠ 오래된 데이터/, '색만이 아니라 글자로도 경고');
assert.match(notice.textContent, /3시간 0분 경과/);
assert.match(notice.textContent, /표시 데이터/);
assert(!notice.textContent.includes('수집이 중단'), '정적 기록으로 현재 수집 중단을 단정하지 않음');

module.namespace.fixture({ builtAt: iso(0), priceAsOf: iso(181), collection: { last_success: iso(1) } });
module.namespace.renderDataStatus(now);
assert.equal(notice.stale, true, '수집 기록과 별도로 가격 기준 시각도 검사');
for (const last of [null, 'invalid']) {
  module.namespace.fixture({ priceAsOf: iso(0), collection: { last_success: last } });
  module.namespace.renderDataStatus(now);
  assert.equal(notice.stale, true);
  assert.match(notice.textContent, /기록 없음/);
  assert.match(elements.get('data-asof')!.textContent, /⚠ 기준 시각 확인 불가/);
}
module.namespace.fixture({ priceAsOf: iso(0), collection: { last_success: iso(1) } });
module.namespace.renderDataStatus(now);
assert.equal(notice.stale, false, '새 데이터로 경고 해제');
assert.match(elements.get('data-asof')!.textContent, /09\. 14\. 15:00 기준/, '헤더 칩은 기준 시각만 짧게 표시');
assert.match(notice.textContent, /가격 계산 기준: 2026.*09.*14.*15:00.*KST/, '전체 기준 시각은 설명에 유지');

// 0업·맥스업 전환 시 빈 호가를 0골드나 일반적인 데이터 누락으로 보이지 않게 한다.
const card = { item_id: 'card', category: '카드', price_basis: 'ask0', span_days: 12,
  last_price: 100, listings: 1, chg: null, max_upgrade: 2, max_span_days: 11,
  max_last_price: null, max_listings: 0, max_vwap24: 900, max_chg: null };
module.namespace.fixture({}, 'max');
await module.namespace.renderDetail(card);
assert.match(view.innerHTML, /현재 관측 매물 없음/);
assert.match(view.innerHTML, /<div class="bigpx">-<\/div>/);
assert.match(view.innerHTML, /24h 평균 2업 최저호가<\/div><div class="v">900/, '현재 매물이 없어도 과거 평균은 보존');
module.namespace.fixture({});
await module.namespace.renderDetail({ ...card, last_price: 0, listings: 0 });
assert.match(view.innerHTML, /현재 관측 매물 없음/);
await module.namespace.renderDetail({ ...card, last_price: null, listings: null });
assert.match(view.innerHTML, /현재 호가 관측 없음/, '관측 기록 없음과 매물 0개를 구분');
await module.namespace.renderDetail(card);
assert.match(view.innerHTML, /<div class="bigpx">100<small>골드<\/small><\/div>/);
assert.doesNotMatch(view.innerHTML, /현재 관측 매물 없음/);
console.log('메인 기준 시각·3시간 경계·누락 기록 경고 테스트 통과');
