// 고정된 R2 실자료만 사용한다. 운영 DB 연결·Neople 호출·R2 쓰기·사이트 배포가 없는 전환 재현 검사.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { readManifest, restore, r2Store, TABLES, quote, type Store } from '../src/archive.ts';
import { unifyMarket, installBuildClock } from '../src/build-unified.ts';
import type { HistoryOwner } from '../src/history-merge.ts';

const url = new URL(process.env.ARCHIVE_VERIFY_URL!);
assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55432'); assert.equal(url.pathname,'/archive_verify');
assert(!process.env.DATABASE_URL && !process.env.DATABASE_URL_B && !process.env.NEOPLE_API_KEY);
const remote = r2Store(), files = new Map<string,Buffer>();
let r2Bytes = 0;
const readonly: Store = { get: async key => {
  if(files.has(key)) return files.get(key)!;
  const bytes = await remote.get(key); if(bytes) { files.set(key,bytes); r2Bytes+=bytes.length; } return bytes;
}, put: async () => { throw new Error('검사 중 R2 쓰기 금지'); } };
const archived = await readManifest(readonly,process.env.SITE_TEST_MANIFEST);
assert(archived); assert(await readonly.get(`verified/${archived.id.slice(10,-5)}.json`));
assert(archived.manifest.shards.reduce((n,s)=>n+s.bytes,0)<50_000_000,'보관본이 검사 예산을 넘습니다');
const client = new pg.Client({ connectionString:url.toString(),ssl:false });
async function build(asOf: string) {
  await new Promise<void>((accept,reject) => {
    const child = spawn(process.execPath,['--no-warnings','web/build.ts'],{env:{...process.env,
      BUILD_DATABASE_URL:url.toString(),BUILD_AS_OF:asOf,BUILD_HISTORY_CACHE:''},stdio:'inherit'});
    child.on('error',reject); child.on('close',code=>code===0?accept():reject(new Error(`사이트 검사 빌드 실패 ${code}`)));
  });
  const result = new Map<string,unknown>();
  async function visit(path: string) {
    for(const item of await readdir(path,{withFileTypes:true})) {
      const file = `${path}/${item.name}`;
      if(item.isDirectory()) await visit(file);
      else if(file.endsWith('.json')) {
        const value = JSON.parse(await readFile(file,'utf8'));
        // 실행 시각과 분석 DB에서 새로 발급한 ID는 내용 대조에서 제외한다.
        delete value.builtAt;
        if(value.quality) delete value.quality.rawMaxId;
        result.set(file,value);
      }
    }
  }
  await visit('dist/data'); return result;
}
try {
  await client.connect();
  const started = Date.now();
  const count = await restore(client,archived.manifest,readonly);
  await client.query(`CREATE VIEW collection_runs AS SELECT id,item_id,source,started_at,finished_at,sold_rows,sold_new,
    sold_span_min,saturated,listing_rows,deltas_found,CASE WHEN status='failed' THEN 'archived failure' ELSE NULL END AS error FROM collection_quality;
    CREATE TABLE collection_health(id bigint,checked_at timestamptz,last_collect_at timestamptz,gap_min numeric,stale_items integer,action text);
    CREATE INDEX ON trades(item_id,sold_date); CREATE INDEX ON listing_snapshots(item_id,captured_at)`);
  await installBuildClock(client);
  const asOf = archived.manifest.createdAt;
  const expected = await build(asOf);
  const cut = new Date(Date.parse(asOf)-6*3600000).toISOString();
  const ids = (await client.query('SELECT item_id FROM items ORDER BY item_id')).rows.map(r=>r.item_id);
  const lastA = (await client.query('SELECT max(id)::text AS id FROM trades WHERE ingested_at<$1',[cut])).rows[0].id;
  await client.query('ALTER SCHEMA public RENAME TO reference; CREATE SCHEMA public; CREATE SCHEMA hist_a; CREATE SCHEMA hist_b');
  for(const table of [...Object.keys(TABLES),'collection_health']) {
    for(const source of ['hist_a','hist_b'])
      await client.query(`CREATE TABLE ${source}.${quote(table)} AS SELECT * FROM reference.${quote(table)}`);
  }
  // ID를 1부터 다시 발급한 새 DB와, 한 시간 겹치는 체결 조회를 실제 보관 자료로 재현한다.
  await client.query('DELETE FROM hist_a.trades WHERE id>$1',[lastA]);
  await client.query("DELETE FROM hist_b.trades WHERE id<=$1 AND sold_date<$2::timestamptz-interval '1 hour'",[lastA,cut]);
  await client.query(`ALTER TABLE hist_b.trades ADD COLUMN original_id bigint;
    UPDATE hist_b.trades SET original_id=id;
    UPDATE hist_b.trades t SET id=r.n FROM (SELECT original_id,row_number() OVER(ORDER BY original_id) AS n FROM hist_b.trades) r WHERE t.original_id=r.original_id;
    UPDATE hist_b.candle_pipeline_state SET raw_max_id=(SELECT max(id) FROM hist_b.trades WHERE original_id<=(SELECT raw_max_id FROM reference.candle_pipeline_state))`);
  await client.query('DELETE FROM hist_a.listing_snapshots WHERE captured_at>=$1',[cut]);
  await client.query("DELETE FROM hist_b.listing_snapshots WHERE captured_at<$1::timestamptz-interval '1 hour'",[cut]);
  const owners: HistoryOwner[] = ids.flatMap(itemId=>[
    {itemId,source:'hist_a',from:null,to:cut},{itemId,source:'hist_b',from:cut,to:null}]);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const report = await unifyMarket(client,['hist_a','hist_b'],owners,asOf,
    [{source:'hist_a',from:null,to:cut},{source:'hist_b',from:cut,to:null}]);
  await client.query('COMMIT');
  const actual = await build(asOf);
  assert.deepEqual([...actual.keys()].sort(),[...expected.keys()].sort());
  for(const [file,value] of actual) assert.deepEqual(value,expected.get(file),`실자료 사이트 출력 불일치: ${file}`);
  console.log(JSON.stringify({manifest:archived.id,sourceAsOf:asOf,rows:count,jsonFiles:actual.size,r2Bytes,
    seconds:Math.round((Date.now()-started)/1000),...report,supabaseBytes:0,productionModified:false,siteReproduced:true}));
} finally { await client.query('ROLLBACK').catch(()=>{}); await client.end(); }
