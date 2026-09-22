import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {capture,combine,restore,hash,objectKey,type Store,type Manifest} from '../src/archive.ts';
import {pruneArchived} from '../src/archive-retention.ts';
import {loadResearch} from '../src/research-data.ts';

const url=new URL(process.env.HISTORY_MERGE_TEST_URL!);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55432');assert.equal(url.pathname,'/history_merge_test');
const client=new pg.Client({connectionString:url.toString(),ssl:false});
const files=new Map<string,Buffer>();
const store:Store={get:async k=>files.get(k)??null,put:async(k,v)=>{files.set(k,v);}};
const project='abcdefghijklmnopqrst';
async function snapshot(previous?:Manifest) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{return await capture(client,store,previous,20_000_000);}finally{await client.query('ROLLBACK');}
}
async function publish(manifest:Manifest) {
  const bytes=Buffer.from(JSON.stringify(manifest)),id=`manifests/${hash(bytes)}.json`;
  await store.put(id,bytes);await store.put(`verified/${hash(bytes)}.json`,Buffer.from(JSON.stringify({
    manifest:id,sourceAsOf:manifest.createdAt,retentionReady:true,currentResearchReproduced:true,researchReproduced:true,usage:{project}})));
  return id;
}
async function restored(manifest:Manifest,check:()=>Promise<void>) {
  await client.query('ALTER SCHEMA public RENAME TO retention_live; CREATE SCHEMA public');
  try {await restore(client,manifest,store);await check();}
  finally {await client.query('DROP SCHEMA public CASCADE; ALTER SCHEMA retention_live RENAME TO public');}
}
const snapshotRows=async()=> (await client.query('SELECT to_jsonb(s)::text row FROM listing_snapshots s ORDER BY id')).rows;
try {
  await client.connect();
  // 같은 CI 작업의 일회성 DB에서만 앞선 테스트 자료를 교체한다.
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for(const file of ['schema.postgres.sql','research.sql','legendary-scans.sql'])await client.query(readFileSync(`sql/${file}`,'utf8'));
  await client.query(`INSERT INTO items(item_id,item_name,category) VALUES ('retention-card','보존 카드','카드');
    INSERT INTO listing_snapshots(id,item_id,captured_at,min_unit_price,listing_count,total_qty,upgrade,upgrade_max) VALUES
      (9007199254740993,'retention-card',now()-interval '30 days',100,1,1,0,2),
      (9007199254740994,'retention-card',now()-interval '29 days',200,1,1,0,2),
      (2,'retention-card',now(),300,1,1,0,2),
      (6,'retention-card',date_trunc('day',now())-interval '14 days',300,1,1,0,2),
      (7,'retention-card',date_trunc('day',now())-interval '14 days 1 microsecond',300,1,1,0,2);
    INSERT INTO listings(auction_no,item_id,reg_date,expire_date,unit_price,reg_count,cur_count,first_seen_at,last_seen_at,closed_at,upgrade_max)
      SELECT id,'retention-card',now()-interval '35 days',now()-interval '32 days',100,1,1,
        now()-interval '35 days',now()-interval '32 days',CASE WHEN id=4 THEN NULL ELSE now()-interval '31 days' END,
        CASE WHEN id=5 THEN 2 ELSE NULL END FROM unnest(ARRAY[9007199254740993,3,4,5]::bigint[]) id`);
  const initial=await snapshot(),archive=await combine(null,initial,store,store,store);
  const id=await publish(archive);
  await client.query(`UPDATE listing_snapshots SET min_unit_price=250 WHERE id=9007199254740994;
    INSERT INTO listing_snapshots(id,item_id,captured_at,min_unit_price,listing_count,total_qty,upgrade,upgrade_max)
      VALUES(9007199254740995,'retention-card',now()-interval '28 days',400,1,1,0,2);
    UPDATE listings SET closed_at=NULL WHERE auction_no=3`);
  const expectedFull=await snapshotRows();
  await assert.rejects(pruneArchived(client,store,'wrong',id,true),/다른 프로젝트/);
  const shard=archive.shards.find(s=>s.table==='listing_snapshots'&&s.day!==initial.createdAt.slice(0,10))!;
  const key=objectKey(shard),bytes=files.get(key)!;
  files.set(key,Buffer.from('broken'));
  await assert.rejects(pruneArchived(client,store,project,id,true),/SHA-256/);
  assert.deepEqual(await snapshotRows(),expectedFull,'훼손 시 아무 행도 지우지 않음');files.set(key,bytes);
  const result=await pruneArchived(client,store,project,id,true);
  assert.equal(result.tables.find(t=>t.table==='listing_snapshots')!.deleted,2);
  assert.equal((await client.query('SELECT 1 FROM listing_snapshots WHERE id=6')).rowCount,1,'보존 경계 시각은 포함');
  assert.equal(result.tables.find(t=>t.table==='listings')!.deleted,1);
  assert.equal((await client.query('SELECT 1 FROM listings WHERE auction_no IN (3,4,5)')).rowCount,3,'재개·열린 매물·카드 최종 단계 보존');
  assert.equal((await client.query('SELECT 1 FROM listing_snapshots WHERE id=9007199254740993')).rowCount,0,'큰 정수 키도 정확히 정리');
  assert.equal((await client.query('SELECT 1 FROM listing_snapshots WHERE id IN (9007199254740994,9007199254740995,2)')).rowCount,3,'수정·미보관·최근 원본 보존');
  assert((await pruneArchived(client,store,project,id,true)).tables.every(t=>t.deleted===0),'재실행 멱등');
  const current=await snapshot(archive),next=await combine(archive,current,store,store,store);
  const expectedCurrent=await loadResearch(client as any,current.createdAt,current.createdAt);
  await restored(current,async()=>assert.deepEqual(await loadResearch(client as any,current.createdAt,current.createdAt),expectedCurrent));
  await restored(next,async()=>assert.deepEqual(await snapshotRows(),expectedFull,'정리 후에도 전체 카드 이력 복원'));
  const reused=await snapshot(next);
  await restored(reused,async()=>assert.deepEqual(await loadResearch(client as any,current.createdAt,current.createdAt),expectedCurrent,
    '다음 변경 없는 보관에서도 현재 DB 입력만 정확히 재현'));
  console.log('보존 정책 검증 통과: 14일 경계·큰 정수·수정/미보관/재개/카드 상태 보호·훼손 중단·재실행·정리 후 현재/전체 이력 재현');
}finally{await client.end();}
