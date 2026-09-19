import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

const source = stripTypeScriptTypes(readFileSync('scripts/legendary-floor.ts', 'utf8'));
async function scan(latest: string | null, now: string, options: {
  force?: boolean; locked?: boolean; fail?: boolean; cards?: number;
  outcomes?: string[]; failCheckpoint?: number; failFloor?: boolean;
} = {}) {
  let calls = 0, inserts = 0, unlocked = false, released = false, ended = false;
  let checkpoints = 0, pendingInserts = 0;
  let run: any = null;
  const logs: string[] = [];
  const clock = Date.parse(now);
  const context = vm.createContext({ Error,
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
    async query(sql: string, args: any[] = []) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: options.locked ?? true }] };
      if (sql.includes('pg_advisory_unlock')) { unlocked = true; return { rows: [{ ok: true }] }; }
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('SELECT MAX(captured_at)')) return { rows: [{ captured_at: latest ? new Date(latest) : null }] };
      if (sql.includes('INSERT INTO legendary_card_scans')) {
        run = { status: 'running', expected: args[1], observations: JSON.parse(args[2]), succeeded: 0, failed: 0 };
        return { rows: [{ id: 7 }] };
      }
      if (sql.includes('UPDATE legendary_card_scans')) {
        if (sql.includes('SET observations=')) {
          if (++checkpoints === options.failCheckpoint) throw new Error('DB checkpoint failed');
          Object.assign(run, { observations: JSON.parse(args[1]), succeeded: args[2], failed: args[3] });
        } else if (run) {
          run.status = sql.includes("status='interrupted'") ? 'interrupted' :
            sql.includes("status='complete'") ? 'complete' : args[1];
        }
        return { rows: [] };
      }
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'COMMIT') { inserts += pendingInserts; pendingInserts = 0; return { rows: [] }; }
      if (sql === 'ROLLBACK') { pendingInserts = 0; return { rows: [] }; }
      if (sql.includes('INSERT INTO legendary_card_floor')) {
        if (options.failFloor) throw new Error('DB floor write failed');
        pendingInserts++; return { rows: [] };
      }
      throw new Error('예상하지 않은 DB 조회');
    },
    release() { released = true; },
  };
  const modules: Record<string, vm.Module> = {
    'node:fs': synthetic({ readFileSync: (path: string) => path.endsWith('.sql') ? readFileSync(path, 'utf8') :
      JSON.stringify(Array.from({ length: options.cards ?? 1 }, (_, i) => ({ itemId: String(i), itemName: `재료 카드 ${i}` }))) }),
    '../src/api.ts': synthetic({ getAuction: async (id: string) => {
      calls++;
      const outcome = options.outcomes?.[Number(id)];
      if (options.fail || outcome === 'failed') throw new Error('/auction → 503 민감한 응답 원문');
      if (outcome === 'empty') return [];
      if (outcome === 'upgraded') return [{ upgrade: 2, unitPrice: 2000000 }];
      if (outcome === 'capped') return Array.from({ length: 400 }, () => ({ upgrade: 0, unitPrice: 1000000 }));
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
  return { calls, inserts, logs, error, run, checkpoints };
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
assert.equal(failed.run.status, 'failed');
assert.equal(failed.run.observations[0].errorCode, 'http_503');
assert(!JSON.stringify(failed.run).includes('민감한'), '오류 원문은 저장하지 않음');
const partial = await scan(null, '2026-09-18T11:05:00+09:00', { cards: 3, outcomes: ['observed','empty','failed'] });
assert.equal(partial.run.status, 'partial');
assert.equal(partial.run.succeeded, 2);
assert.equal(partial.run.failed, 1);
assert.deepEqual(partial.run.observations.map((r: any) => r.status), ['observed','empty','failed']);
assert.equal(partial.inserts, 0, '조회 누락이 있으면 전체 최저가·P10으로 발표하지 않음');
assert.equal(partial.error, undefined, '부분 실패가 다른 사이트 데이터의 배포를 막지 않음');
const empty = await scan(null, '2026-09-18T11:05:00+09:00', { cards: 2, outcomes: ['empty','upgraded'] });
assert.equal(empty.run.status, 'complete', '정상 무매물은 조회 실패와 구분');
assert.equal(empty.run.observations[1].responseRows, 1, '다른 업그레이드 단계 응답 수 보존');
assert(empty.run.observations.every((r: any) => r.status === 'empty' && r.minPrice === null && r.listingCount === 0));
assert.equal(empty.inserts, 0);
const capped = await scan(null, '2026-09-18T11:05:00+09:00', { outcomes: ['capped'] });
assert.equal(capped.run.observations[0].capped, true);
assert.equal(capped.run.observations[0].listingCount, 400);
assert.equal(capped.run.status, 'complete');
const interrupted = await scan(null, '2026-09-18T11:05:00+09:00', { cards: 12, failCheckpoint: 2 });
assert.equal(interrupted.run.status, 'interrupted');
assert.equal(interrupted.run.observations.filter((r: any) => r.status === 'observed').length, 10, '저장된 묶음은 중단 후에도 보존');
assert.equal(interrupted.run.observations.filter((r: any) => r.status === 'pending').length, 2, '미저장 결과는 무매물이 아님');
assert.equal(interrupted.inserts, 0);
const failedWrite = await scan(null, '2026-09-18T11:05:00+09:00', { failFloor: true });
assert.equal(failedWrite.run.status, 'interrupted');
assert.equal(failedWrite.run.observations[0].minPrice, 1000000, '지수 저장 실패에도 앞서 저장한 카드 기록은 유지');
assert.equal(failedWrite.inserts, 0);
assert.equal((await scan('2026-09-18T10:05:00+09:00', '2026-09-18T11:15:00+09:00')).inserts, 1,
  '실패 후 같은 시간대에 재시도 가능');
console.log('레전더리 시간 경계·중복·부분/전체 실패·무매물·중단 기록·재시도 테스트 통과');
