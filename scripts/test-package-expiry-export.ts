import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { eventWindow, scoreIssues, RESEARCH_VERSION } from '../src/research.ts';

// 실제 exporter를 실행하되 조회만 대체한다. 삭제 뒤 데이터가 남아 있어도 배포하지 않는지 확인.
const members = JSON.parse(readFileSync('config/package-study-members.json', 'utf8')).filter((m: any) => m.group === 'treatment');
const packageId = members[0].id, partIds = members.slice(1).map((m: any) => m.id);
const rows = members.flatMap((m: any) => ['2026-11-04', '2026-11-05', '2026-11-06'].map(d => ({ item_id: m.id, d, value: 100, qty: 5 })));
const context = vm.createContext({});
const modules: Record<string, Record<string, unknown>> = {
  './history-cache.ts': { HistoryCache: class {} },
  './research-data.ts': { PACKAGE_ID: packageId, PART_IDS: partIds, loadResearch: async () => ({
    series: [{ id: 'soul', daily: [] }], trade: rows, byBasis: new Map(), before: '2026-12-03',
  }) },
  './research.ts': { RESEARCH_VERSION, eventWindow, scoreIssues },
};
const source = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync('src/research-export.ts', 'utf8')), { context });
await source.link(async name => {
  const values = modules[name];
  assert(values, name);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await source.evaluate();
const client = { query: async (sql: string) => ({ rows: sql.includes('FROM items')
  ? members.map((m: any) => ({ item_id: m.id, item_name: m.name }))
  : sql.includes('FROM events') ? [{ name: '숲속의 유랑악단 패키지', starts: '2026-08-27', ends: '2026-11-05', source_url: 'https://df.nexon.com/community/news/seriashop/656' }] : [] }) };
const cache = { query: () => async () => ({ rows: [] }) };
const result = await (source.namespace as any).researchExport(client, '2026-12-03T00:00:00Z', '2026-12-03', cache);
assert.equal(result.package.daily.length, 1);
assert.equal(result.package.daily[0].d, '2026-11-04');
assert(result.package.components.every((c: any) => c.daily.length === 1));
const end = result.package.stages.find((s: any) => s.label === '판매 종료');
assert(end.unavailableReason.includes('삭제'));
assert.equal(end.metrics.price.ready, false);
assert.equal(end.metrics.price.change, null);
assert.equal(end.metrics.margin.post, null);
console.log('package expiry export: 삭제 당일·이후 가격/구성품 제외 및 사후 비교 차단 통과');
