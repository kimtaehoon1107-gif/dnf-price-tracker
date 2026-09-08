import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import * as logic from '../src/market-logic.ts';

const source = (name: string) => stripTypeScriptTypes(readFileSync(`src/${name}.ts`, 'utf8'));
const synthetic = (values: Record<string, unknown>, context: vm.Context) =>
  new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });

// 잘린 응답의 동가 매물과 고가 매물을 판매로 오판하지 않아야 한다.
for (const count of [399, 400]) {
  const context = vm.createContext({ console, Date, Map, Set });
  let reasons: string[] = [], closed: number[] = [], invalidated = false;
  const query = async (sql: string, args: any[] = []) => {
    if (sql.includes('SELECT i.category')) return { rows: [{ category: '소울 결정', t: null }] };
    if (sql.includes('RETURNING id')) return { rows: [{ id: 1 }] };
    if (sql.includes('SELECT auction_no')) return { rows: [49999, 50000, 50001].map((price, i) => ({
      auction_no: String(900 + i), unit_price: price, cur_count: 140, expire_date: new Date('2099-01-01'),
    })) };
    if (sql.includes('INSERT INTO listing_deltas')) reasons = args[7];
    if (sql.includes('UPDATE listings SET closed_at = $1')) closed = args[1];
    if (sql.includes('UPDATE listing_deltas SET invalidated_at')) {
      invalidated = args[0].length === count && sql.includes("reason = 'vanished_before_expiry'");
    }
    return { rows: [], rowCount: 0 };
  };
  const modules: Record<string, vm.Module> = {
    './db.ts': synthetic({ withItemLock: async (_id: string, fn: any) => fn({ query }),
      tx: async (fn: any, borrowed: unknown) => { assert(borrowed); return fn({ query }); },
      nowIso: () => new Date().toISOString(), quantile: (a: number[]) => a[0] ?? null }, context),
    './api.ts': synthetic({ getSold: async () => [], getAuction: async () =>
      Array.from({ length: count }, (_, i) => ({ auctionNo: i + 1, unitPrice: 50000, count: 1,
        regDate: '2026-09-08 00:00:00', expireDate: '2099-01-01 00:00:00', reinforce: 0 })),
    kstToIso: (s: string) => new Date(s.replace(' ', 'T') + '+09:00').toISOString() }, context),
    './market-logic.ts': synthetic(logic, context),
  };
  const module = new vm.SourceTextModule(source('collect'), { context });
  await module.link((name) => modules[name]); await module.evaluate();
  const result = await module.namespace.collectItem('fixture');
  assert.equal(result.qtyObserved, count === 400 ? 140 : 420);
  assert.deepEqual(Array.from(closed), count === 400 ? [900] : [900, 901, 902]);
  assert(reasons.every((r) => r === 'vanished_before_expiry'));
  assert(invalidated, '재관측 매물의 이전 소진 판정을 무효화해야 한다.');
}

async function runCollector(once: boolean, failures: boolean[]) {
  let clock = Date.now(), call = 0;
  const stop = new Error('mock exit');
  const processMock = {
    argv: ['node', 'run.ts', ...(once ? ['--once'] : ['--minutes', '3'])], env: {},
    exitCode: 0, on() {}, exit(code: number) { this.exitCode = code; throw stop; },
  };
  const context = vm.createContext({
    console: { log() {}, error() {} }, process: processMock, Map,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(fn: () => void, ms: number) { clock += ms; queueMicrotask(fn); },
  });
  const modules: Record<string, vm.Module> = {
    './collect.ts': synthetic({ collectItem: async () => {
      const fail = failures[Math.min(call++, failures.length - 1)];
      if (fail) throw new Error('API fixture failure');
      return { soldRows: 0, soldNew: 0, deltas: 0, qtyObserved: 0, saturated: false, spanMin: null };
    } }, context),
    './db.ts': synthetic({ query: async () => ({ rows: [{ item_id: 'fixture', item_name: 'fixture',
      poll_interval_sec: 120, last_success: null }] }), pool: { end: async () => {} } }, context),
    './market-logic.ts': synthetic(logic, context),
  };
  const module = new vm.SourceTextModule(source('run'), { context });
  await module.link((name) => modules[name]);
  try { await module.evaluate(); } catch (e) { if (e !== stop) throw e; }
  return processMock.exitCode;
}
assert.equal(await runCollector(true, [true]), 1);
assert.equal(await runCollector(true, [false]), 0);
assert.equal(await runCollector(false, [true]), 1);
assert.equal(await runCollector(false, [true, false]), 0);
console.log('수집 경계·재관측·실패 상태 테스트 통과');
