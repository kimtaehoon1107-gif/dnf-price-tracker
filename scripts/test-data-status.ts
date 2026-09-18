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
  console, Date, document: { getElementById: (id: string) => elements.get(id) },
  fetch: () => new Promise(() => {}),
});
const module = new vm.SourceTextModule(readFileSync('web/app.js', 'utf8') +
  '\nexport {renderDataStatus}; export function fixture(data) { DATA = data; }', { context });
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
}
module.namespace.fixture({ priceAsOf: iso(0), collection: { last_success: iso(1) } });
module.namespace.renderDataStatus(now);
assert.equal(notice.stale, false, '새 데이터로 경고 해제');
assert.match(elements.get('data-asof')!.textContent, /2026.*09.*14.*15:00.*KST/);
console.log('메인 기준 시각·3시간 경계·누락 기록 경고 테스트 통과');
