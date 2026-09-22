// 전역 작업은 B에 기록하지만 수집 상태와 종목 목록은 모든 현재 담당 DB에서 읽는다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

export function liveProjects() {
  const path='config/history-sources.json';
  if(!existsSync(path)) return [{name:'current',connectionString:process.env.DATABASE_URL!,ids:null as string[]|null}];
  const config=JSON.parse(readFileSync(path,'utf8'));
  return config.live.map((source:{schema:string;secret:string;project:string})=>{
    assert(['DATABASE_URL_B','DATABASE_URL_C'].includes(source.secret));
    const connectionString=process.env[source.secret];
    assert(connectionString,`${source.secret} 연결 설정이 없습니다`);
    assert.equal(new URL(connectionString).username,`postgres.${source.project}`);
    return {name:source.schema,connectionString,
      ids:config.owners.filter((o:any)=>o.source===source.schema&&o.to===null).map((o:any)=>o.itemId) as string[]};
  }) as {name:string;connectionString:string;ids:string[]|null}[];
}

export function liveClient(connectionString:string) {
  return new pg.Client({connectionString,connectionTimeoutMillis:15000,query_timeout:30000,
    ssl:{ca:readFileSync(new URL('../certs/supabase-prod-ca-2021.crt',import.meta.url),'utf8'),rejectUnauthorized:true}});
}

export async function trackedItems() {
  const result: {item_id:string;item_name:string}[]=[];
  for(const source of liveProjects()) {
    const client=liveClient(source.connectionString);
    try {
      await client.connect();
      const rows=(await client.query<{item_id:string;item_name:string}>(
        'SELECT item_id,item_name FROM items WHERE tracked ORDER BY item_id')).rows;
      if(source.ids) assert.deepEqual(rows.map(r=>r.item_id),[...source.ids].sort(),`${source.name} 종목 담당 불일치`);
      result.push(...rows);
    } finally {await client.end();}
  }
  assert.equal(new Set(result.map(r=>r.item_id)).size,result.length,'종목 담당 중복');
  return result;
}
