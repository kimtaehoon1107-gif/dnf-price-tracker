import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { captureReplica, restoreReplica, publishReplica, readReplica } from '../src/build-replica.ts';
import { encode,decode,hash,type Store,type Row } from '../src/archive.ts';

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
  await local.query(`INSERT INTO legendary_card_scans(id,started_at,status,expected,observations) VALUES
    (101,'2026-09-22T00:00:00Z','complete',1,'[]'),(102,'2026-09-22T01:00:00Z','complete',1,'[]')`);
  await local.query(`CREATE TABLE collection_health(id bigserial PRIMARY KEY,checked_at timestamptz,last_collect_at timestamptz,
    gap_min numeric,stale_items integer,action text);
    INSERT INTO trades(id,item_id,sold_date,unit_price,count,price) VALUES (777,'soul','2026-09-22T01:00:00Z',10,1,10)`);
  // 더 큰 ID가 보인 뒤 커밋되는 작은 ID도 다음 해시 대조에서 발견해야 한다.
  await writer.query('BEGIN');
  await writer.query("INSERT INTO trades(id,item_id,sold_date,unit_price,count,price) VALUES (42,'soul','2026-09-22T00:00:00Z',10,1,10)");
  const first = await capture();
  assert(first.stats.fetchedBytes > 0 && first.stats.fetchedChunks > 0);
  assert(first.replica.chunks.filter(c=>c.table==='trades').every(c=>/^\d{4}-\d{2}-\d{2}\/\d{2}$/.test(c.bucket)),
    '체결을 시간별로 묶어 완료된 시간을 재사용');
  assert(first.replica.chunks.filter(c=>c.table==='listings').length<=1,'현재 호가를 수백 개 작은 객체로 나누지 않음');
  await restore(first.replica,'mirror_first');
  assert.equal((await local.query('SELECT 1 FROM mirror_first.trades WHERE id=42')).rowCount,0);
  const legacy=structuredClone(first.replica),days=new Map<string,Row[]>();
  for(const c of legacy.chunks.filter(c=>['trades','legendary_card_scans'].includes(c.table))) {
    const rows=decode(files.get(`build-replica/objects/${c.hash}.jsonl.gz`)!,{...c,day:c.bucket});
    const day=c.table==='trades'?`trades:${c.bucket.slice(0,10)}`:'legendary_card_scans:0';days.set(day,[...days.get(day)??[],...rows]);
  }
  legacy.chunks=legacy.chunks.filter(c=>!['trades','legendary_card_scans'].includes(c.table));
  for(const [id,rows] of days) {
    const [table,bucket]=id.split(':');
    const bytes=encode(rows),sourceHash=hash([...rows].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(r=>r.row+'\n').join(''));
    const c={table,bucket,hash:hash(bytes),sourceHash,rows:rows.length,bytes:bytes.length};
    files.set(`build-replica/objects/${c.hash}.jsonl.gz`,bytes);legacy.chunks.push(c);
  }
  await publishReplica(store,legacy,first.previous);
  const readsBeforeMigration=reads;
  const warm = await capture();
  assert.equal(warm.stats.fetchedBytes,0); assert.equal(warm.stats.fetchedChunks,0);
  assert.equal(reads,readsBeforeMigration,'날짜→시간 전환은 R2만 사용');
  assert.deepEqual(warm.previous,legacy,'경합 검사용 이전 manifest를 변경하지 않음');
  assert(warm.stats.reusedChunks > 0);
  await restore(warm.replica,'mirror_warm');
  await publishReplica(store,warm.replica,warm.previous);
  await local.query("INSERT INTO trades(id,item_id,sold_date,unit_price,count,price) VALUES (778,'soul','2026-09-22T02:00:00Z',10,1,10)");
  const nextHour=await capture();
  assert.equal(nextHour.stats.fetchedChunks,1,'같은 날 다음 시간 체결은 그 시간만 가져옴');
  assert(nextHour.stats.fetchedBytes<1000,'하루 전체 체결을 다시 가져오지 않음');
  await publishReplica(store,nextHour.replica,nextHour.previous);
  await local.query(`INSERT INTO legendary_card_scans(id,started_at,status,expected,observations)
    VALUES (103,'2026-09-22T02:00:00Z','complete',1,'[]')`);
  const nextScan=await capture();
  assert.equal(nextScan.stats.fetchedChunks,1,'카드 조사도 이전 256개 대신 새 시간만 조회');
  assert(nextScan.stats.fetchedBytes<1000);
  await restore(nextScan.replica,'mirror_scans');
  assert.equal((await local.query('SELECT count(*)::int n FROM mirror_scans.legendary_card_scans')).rows[0].n,3);
  await publishReplica(store,nextScan.replica,nextScan.previous);
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
