import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

const source = stripTypeScriptTypes(readFileSync('scripts/legendary-floor.ts', 'utf8'));
async function scan(latest: string | null, now: string, options: { force?: boolean; locked?: boolean; fail?: boolean } = {}) {
  let calls = 0, inserts = 0, unlocked = false, released = false, ended = false;
  const logs: string[] = [];
  const clock = Date.parse(now);
  const context = vm.createContext({
    console: { log: (...args: unknown[]) => logs.push(args.join(' ')), warn: (...args: unknown[]) => logs.push(args.join(' ')) },
    process: { argv: ['node', 'legendary-floor.ts', ...(options.force ? ['--force'] : [])] },
    Date: class extends Date {
      constructor(value?: string | number) { super(value ?? clock); }
      static now() { return clock; }
    },
  });
  const synthetic = (values: Record<string, unknown>) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
  const client = {
    async query(sql: string) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: options.locked ?? true }] };
      if (sql.includes('pg_advisory_unlock')) { unlocked = true; return { rows: [] }; }
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('SELECT MAX(captured_at)')) return { rows: [{ captured_at: latest ? new Date(latest) : null }] };
      if (sql.includes('INSERT INTO legendary_card_floor')) { inserts++; return { rows: [] }; }
      throw new Error('예상하지 않은 DB 조회');
    },
    release() { released = true; },
  };
  const modules: Record<string, vm.Module> = {
    'node:fs': synthetic({ readFileSync: () => JSON.stringify([{ itemId: 'fixture', itemName: '재료 카드' }]) }),
    '../src/api.ts': synthetic({ getAuction: async () => {
      calls++;
      if (options.fail) throw new Error('/auction → 503 (재시도 4회 실패)');
      return [{ upgrade: 0, unitPrice: 1000000 }];
    } }),
    '../src/db.ts': synthetic({ pool: { connect: async () => client, end: async () => { ended = true; } } }),
  };
  const module = new vm.SourceTextModule(source, { context });
  await module.link((name) => modules[name]);
  let error: unknown;
  try { await module.evaluate(); } catch (e) { error = e; }
  assert(released && ended, '건너뜀·실패에서도 연결 정리');
  assert.equal(unlocked, options.locked ?? true, '획득한 잠금만 해제');
  return { calls, inserts, logs, error };
}

// TOP100 집계로 10:17에 관측했어도 11시의 관측을 건너뛰면 안 된다.
for (const [latest, now] of [
  ['2026-09-18T10:17:50+09:00', '2026-09-18T11:05:19+09:00'],
  ['2026-09-18T10:59:59+09:00', '2026-09-18T11:00:00+09:00'],
  ['2026-09-18T23:59:59+09:00', '2026-09-19T00:00:00+09:00'],
  [null, '2026-09-18T11:05:00+09:00'],
]) {
  const result = await scan(latest, now!);
  assert.equal(result.error, undefined);
  assert.equal(result.inserts, 1, `${latest} 다음 ${now}에는 관측 저장`);
}
for (const now of ['2026-09-18T10:05:00+09:00', '2026-09-18T10:56:00+09:00']) {
  const result = await scan('2026-09-18T10:00:00+09:00', now);
  assert.equal(result.calls, 0, '같은 시간대의 재배포는 API 중복 호출 안 함');
  assert.equal(result.inserts, 0);
}
assert.equal((await scan('2026-09-18T10:00:00+09:00', '2026-09-18T10:05:00+09:00', { force: true })).inserts, 1);
assert.equal((await scan(null, '2026-09-18T11:05:00+09:00', { locked: false })).calls, 0);
const failed = await scan('2026-09-18T10:05:00+09:00', '2026-09-18T11:05:00+09:00', { fail: true });
assert(failed.error, 'API 장애는 성공으로 처리하지 않음');
assert.match(String(failed.error), /API 조회가 모두 실패/, '전체 API 실패를 매물 없음과 구분');
assert(failed.logs.some((line) => line.includes('API 조회 실패 1/1종')));
assert.equal(failed.inserts, 0, '실패한 시간에 이전 가격이나 0원을 기록하지 않음');
assert.equal((await scan('2026-09-18T10:05:00+09:00', '2026-09-18T11:15:00+09:00')).inserts, 1,
  '실패 후 같은 시간대에 재시도 가능');
console.log('레전더리 수집 시간 경계·중복·실패 재시도 테스트 통과');
