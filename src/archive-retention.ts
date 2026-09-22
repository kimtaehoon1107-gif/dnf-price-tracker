import assert from 'node:assert/strict';
import type { Client, PoolClient } from 'pg';
import { hash, quote, readManifest, readRows, type Store } from './archive.ts';

const keys={listing_snapshots:'id',listings:'auction_no'};
type Table=keyof typeof keys;
export function retentionPredicate(table:Table) {
  if(table==='listing_snapshots') return 't.captured_at<$1::timestamptz';
  // 마지막 카드 단계 정보와 아직 살아날 수 있는 매물은 수집기의 비교 상태다.
  return `t.closed_at<$1::timestamptz AND t.expire_date<$1::timestamptz AND t.auction_no NOT IN
    (SELECT DISTINCT ON(item_id) auction_no FROM public.listings WHERE upgrade_max IS NOT NULL
      ORDER BY item_id,upgrade_max DESC,last_seen_at DESC,auction_no DESC)`;
}

export async function pruneArchived(client:Client|PoolClient,store:Store,project:string,manifestId:string,apply=false) {
  const archive=await readManifest(store,manifestId);assert(archive);
  const verification=await store.get(`verified/${manifestId.slice(10,-5)}.json`);assert(verification,'보관 검증 기록 없음');
  const verified=JSON.parse(verification.toString());
  assert(verified.retentionReady && verified.currentResearchReproduced && verified.researchReproduced,'현재 입력/전체 보관본 복원 검증 필요');
  assert.equal(verified.manifest,manifestId);assert.equal(verified.sourceAsOf,archive.manifest.createdAt);
  assert.equal(verified.usage?.project,project,'다른 프로젝트 보관본');
  const cutoff=new Date(Date.parse(archive.manifest.createdAt)-14*86400000).toISOString().slice(0,10)+'T00:00:00.000Z';
  await client.query("SET TIME ZONE 'UTC'; SET DateStyle='ISO,YMD'; SET extra_float_digits=3; SET lock_timeout='3s'; SET statement_timeout='30s'");
  assert((await client.query('SELECT pg_try_advisory_lock(731905,20260923) locked')).rows[0].locked,'다른 정리 작업 실행 중');
  const result={project,manifest:manifestId,cutoff,apply,tables:[] as {table:string;candidates:number;proven:number;deleted:number}[]};
  try {
    let readBytes=0,proofCount=0;
    const planned: {table:Table;proofs:{key:string;digest:string}[];candidates:number}[]=[];
    // 파일 누락·훼손·예산 초과는 어느 행도 삭제하기 전에 발견한다.
    for(const table of Object.keys(keys) as Table[]) {
      const time=table==='listings'?'first_seen_at':'captured_at';
      const days=(await client.query(`SELECT to_char(t.${time} AT TIME ZONE 'UTC','YYYY-MM-DD') day,count(*)::int n
        FROM public.${table} t WHERE ${retentionPredicate(table)} GROUP BY 1 ORDER BY 1`,[cutoff])).rows;
      const proofs:{key:string;digest:string}[]=[];
      for(const day of days) {
        const shard=archive.manifest.shards.find(s=>s.table===table&&s.day===day.day);
        if(!shard) continue; // 아직 보관하지 못한 날짜는 남긴다.
        readBytes+=shard.bytes;assert(readBytes<=20_000_000,'정리용 R2 읽기 20MB 예산 초과');
        for(const row of await readRows(store,shard)) {
          const data=JSON.parse(row.row);
          const eligible=table==='listings'
            ? data.closed_at && Date.parse(data.closed_at)<Date.parse(cutoff) && Date.parse(data.expire_date)<Date.parse(cutoff)
            : Date.parse(data.captured_at)<Date.parse(cutoff);
          if(eligible) proofs.push({key:row.key,digest:hash(row.row)});
        }
      }
      proofCount+=proofs.length;assert(proofCount<=100_000,'정리 증명 10만 행 예산 초과');
      planned.push({table,proofs,candidates:days.reduce((n,d)=>n+d.n,0)});
    }
    for(const {table,proofs,candidates} of planned) {
      let deleted=0;
      if(apply) for(let i=0;i<proofs.length;i+=1000) {
        // 정밀도를 잃는 JS 숫자 대신 원문 키를 Postgres에서 해석한다. 갱신된 행은 남긴다.
        const r=await client.query(`WITH removed AS (DELETE FROM public.${quote(table)} t
          USING jsonb_to_recordset($2::jsonb) p(key text,digest text)
          WHERE t.${keys[table]}=(p.key::jsonb->>0)::bigint AND ${retentionPredicate(table)}
            AND encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')=p.digest RETURNING 1)
          SELECT count(*)::int n FROM removed`,[cutoff,JSON.stringify(proofs.slice(i,i+1000))]);
        deleted+=r.rows[0].n;
      }
      result.tables.push({table,candidates,proven:proofs.length,deleted});
    }
    return result;
  } finally {await client.query('SELECT pg_advisory_unlock(731905,20260923)');}
}
