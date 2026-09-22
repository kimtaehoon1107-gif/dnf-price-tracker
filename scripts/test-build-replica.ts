import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { captureReplica, restoreReplica, publishReplica, readReplica } from '../src/build-replica.ts';
import type { Store } from '../src/archive.ts';

const url = new URL(process.env.HISTORY_MERGE_TEST_URL!);
assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55432'); assert.equal(url.pathname,'/history_merge_test');
const source = new pg.Client({ connectionString: url.toString(), ssl: false });
const local = new pg.Client({ connectionString: url.toString(), ssl: false });
const writer = new pg.Client({ connectionString: url.toString(), ssl: false });
const files = new Map<string,Buffer>();
const store: Store = { get: async k => files.get(k) ?? null, put: async (k,v) => { files.set(k,v); } };
const project = 'abcdefghijklmnopqrst';
let reads = 0;
const originalQuery = source.query.bind(source);
(source as any).query = (...args: any[]) => { if (String(args[0]).startsWith('FETCH')) reads++; return (originalQuery as any)(...args); };
async function capture(budget = 10_000_000) {
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { return await captureReplica(source, store, project, budget); }
  finally { await source.query('ROLLBACK'); }
}
async function restore(replica: Awaited<ReturnType<typeof capture>>['replica'], schema: string) {
  await local.query('BEGIN');
  try { await restoreReplica(local, store, replica, schema); await local.query('COMMIT'); }
  catch (e) { await local.query('ROLLBACK'); throw e; }
}
try {
  await source.connect(); await local.connect(); await writer.connect();
  await local.query(readFileSync('sql/legendary-scans.sql','utf8'));
  await local.query(`CREATE TABLE collection_health(id bigserial PRIMARY KEY,checked_at timestamptz,last_collect_at timestamptz,
    gap_min numeric,stale_items integer,action text);
    INSERT INTO trades(id,item_id,sold_date,unit_price,count,price) VALUES (777,'soul','2026-09-22T01:00:00Z',10,1,10)`);
  // 더 큰 ID가 보인 뒤 커밋되는 작은 ID도 다음 해시 대조에서 발견해야 한다.
  await writer.query('BEGIN');
  await writer.query("INSERT INTO trades(id,item_id,sold_date,unit_price,count,price) VALUES (42,'soul','2026-09-22T00:00:00Z',10,1,10)");
  const first = await capture();
  assert(first.stats.fetchedBytes > 0 && first.stats.fetchedChunks > 0);
  assert(first.replica.chunks.filter(c=>c.table==='trades').every(c=>/^\d{4}-\d{2}-\d{2}$/.test(c.bucket)),
    '중복 INSERT로 생긴 ID 간격 대신 체결 날짜로 묶음');
  assert(first.replica.chunks.filter(c=>c.table==='listings').length<=1,'현재 호가를 수백 개 작은 객체로 나누지 않음');
  await restore(first.replica,'mirror_first');
  assert.equal((await local.query('SELECT 1 FROM mirror_first.trades WHERE id=42')).rowCount,0);
  await publishReplica(store,first.replica,first.previous);
  const warm = await capture();
  assert.equal(warm.stats.fetchedBytes,0); assert.equal(warm.stats.fetchedChunks,0);
  assert(warm.stats.reusedChunks > 0);
  await restore(warm.replica,'mirror_warm');
  await publishReplica(store,warm.replica,warm.previous);
  await writer.query('COMMIT');
  await local.query("DELETE FROM trades WHERE id=777; UPDATE trades SET refine=2 WHERE id=1");
  const changed = await capture();
  assert(changed.stats.fetchedChunks > 0 && changed.stats.reusedChunks > 0);
  await restore(changed.replica,'mirror_changed');
  assert.equal((await local.query('SELECT 1 FROM mirror_changed.trades WHERE id=42')).rowCount,1);
  assert.equal((await local.query('SELECT 1 FROM mirror_changed.trades WHERE id=777')).rowCount,0);
  assert.equal((await local.query('SELECT refine FROM mirror_changed.trades WHERE id=1')).rows[0].refine,2);
  assert.equal((await local.query('SELECT unit_price::text AS n FROM mirror_changed.trades WHERE id=9007199254740993')).rows[0].n,'9007199254740993');
  const before = reads;
  await assert.rejects(capture(1),/전송 예산 초과/);
  assert.equal(reads,before,'예산 검사 전에 원문을 읽으면 안 됩니다');
  const chunk = changed.replica.chunks[0];
  const key = `build-replica/objects/${chunk.hash}.jsonl.gz`, bytes = files.get(key)!;
  files.delete(key);
  await assert.rejects(restore(changed.replica,'mirror_missing'),/객체가 없습니다/);
  assert.equal(reads,before,'R2 누락 때 DB 전체 다운로드로 대체하면 안 됩니다');
  files.set(key,Buffer.from('broken'));
  await assert.rejects(restore(changed.replica,'mirror_corrupt'),/SHA-256/);
  files.set(key,bytes);
  await assert.rejects(publishReplica(store,changed.replica,null),/다른 빌드/);
  await publishReplica(store,changed.replica,changed.previous);
  assert.deepEqual(await readReplica(store,project),changed.replica);
  assert.equal(await readReplica(store,'bbbbbbbbbbbbbbbbbbbb'),null,'프로젝트 캐시가 섞이면 안 됩니다');
  console.log('빌드 복제본 검증 통과: 재사용·수정·삭제·늦은 커밋·정밀도·사전 전송 예산·R2 누락/훼손·출처 격리·경합 중단');
} finally {
  await writer.query('ROLLBACK').catch(() => {});
  await Promise.all([source.end(),local.end(),writer.end()]);
}
