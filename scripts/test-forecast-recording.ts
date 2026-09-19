import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import * as research from '../src/research.ts';

const { RESEARCH_VERSION: current, LEGACY_RESEARCH_VERSION: legacy } = research;
const batches = [legacy, current].map((version) => ({ version, origin: '2026-09-17', issues: [{
  series: 'card', predictions: [{ h: 1, d: '2026-09-18' }, { h: 7, d: '2026-09-24' }],
}] }));
const actuals = [{ version: legacy, target: '2026-09-17', values: { card: 777 } }];
const original = JSON.stringify(batches[0]);
const loads: string[] = [];
let released = 0, ended = 0;
const client = {
  async query(sql: string, args: any[] = []) {
    if (sql.startsWith('SELECT origin,issues')) return { rows: batches.filter((b) => b.version === args[0]) };
    if (sql.startsWith('SELECT target')) return { rows: actuals.filter((a) => a.version === args[0]) };
    if (sql.startsWith('INSERT INTO research_forecast_batches')) {
      assert.equal(args[0], current, '새 발행은 v2만');
      if (batches.some((b) => b.version === args[0] && b.origin === args[1])) return { rows: [], rowCount: 0 };
      batches.push({ version: args[0], origin: args[1], issues: JSON.parse(args[3]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO research_actuals')) {
      assert(!actuals.some((a) => a.version === args[0] && a.target === args[1]), '확정 실측은 재작성하지 않음');
      actuals.push({ version: args[0], target: args[1], values: JSON.parse(args[2]) });
    }
    return { rows: [{ ok: true }], rowCount: 0 };
  },
  release() { released++; },
};
for (let attempt = 0; attempt < 2; attempt++) {
  const processMock = { exitCode: 0 };
  const context = vm.createContext({ console: { log() {}, error() {} }, process: processMock, URL, Date });
  const synthetic = (values: Record<string, unknown>) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [k, v] of Object.entries(values)) this.setExport(k, v);
  }, { context });
  const modules: Record<string, vm.Module> = {
    'node:fs': synthetic({ readFileSync: () => '' }),
    '../src/db.ts': synthetic({ pool: { connect: async () => client, end: async () => { ended++; } } }),
    '../src/research.ts': synthetic(research),
    '../src/candle-check.ts': synthetic({ checkCandles: async () => ({
      stale: false, mismatches: 0, checkedAt: '2026-09-20T03:00:00+09:00', through: '2026-09-20T02:00:00+09:00',
    }) }),
    '../src/research-data.ts': synthetic({ loadResearch: async (_c: unknown, _a: string, _t: string, version = current) => {
      loads.push(version);
      return { before: '2026-09-20', series: [{ id: 'card', daily: [
        { d: '2026-09-18', value: version === legacy ? 100 : null }, { d: '2026-09-19', value: 110 },
      ] }] };
    } }),
  };
  const module = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync('scripts/record-forecasts.ts', 'utf8')),
    { context, initializeImportMeta(meta) { meta.url = 'file:///fixture/record-forecasts.ts'; } });
  await module.link((name) => modules[name]);
  await module.evaluate();
  assert.equal(processMock.exitCode, 0);
}
assert.equal(JSON.stringify(batches[0]), original, 'v1 입력·예측은 불변');
assert.equal(batches.length, 3, '중복 실행에서도 현재 발행은 한 번');
assert.equal(actuals.length, 3);
assert.equal(actuals[0].values.card, 777, '기존 확정값 보존');
assert.equal(actuals.find((a) => a.version === legacy && a.target === '2026-09-18')!.values.card, 100);
assert.equal(actuals.find((a) => a.version === current && a.target === '2026-09-18')!.values.card, null);
assert(!actuals.some((a) => a.target === '2026-09-24'), '미래 대상일은 평가 대기');
assert.equal(loads.filter((v) => v === legacy).length, 1, '마감할 실측이 있을 때만 기존 집계 실행');
assert.equal(released, 2); assert.equal(ended, 2);
console.log('연구 버전 전환·기존 예측 보존·버전별 실측·중복 발행 방지 테스트 통과');
