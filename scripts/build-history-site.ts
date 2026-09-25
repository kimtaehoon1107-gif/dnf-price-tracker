// 고정 A 보관본 + 새 DB의 작은 변경 묶음 → 일회성 분석 DB → 동일 사이트 빌드.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { r2Store, readManifest, restore, projectArchiveStore, quote, TABLES } from '../src/archive.ts';
import { captureReplica, restoreReplica, publishReplica, readReplica } from '../src/build-replica.ts';
import { unifyMarket } from '../src/build-unified.ts';
import { checkCandles } from '../src/candle-check.ts';
import type { HistoryOwner } from '../src/history-merge.ts';

const config=JSON.parse(readFileSync('config/history-sources.json','utf8')) as {
  frozen: { project:string; manifest:string }; live: {project:string; schema:string; secret:'DATABASE_URL_B'|'DATABASE_URL_C'}[];
  owners: HistoryOwner[]; globals: {source:string;from:string|null;to:string|null}[];
};
assert.equal(config.frozen.project,'ypmnadqnmadrburkrcka');
assert(config.live.length>0 && config.live.length<=2);
assert.equal(new Set(config.live.map(s=>s.project)).size,config.live.length);
const url=new URL(process.env.ARCHIVE_VERIFY_URL!);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55432');assert.equal(url.pathname,'/archive_verify');
const local=new pg.Client({connectionString:url.toString(),ssl:false});
const store=r2Store(), ssl={ca:readFileSync('certs/supabase-prod-ca-2021.crt','utf8'),rejectUnauthorized:true};
const sources: pg.Client[]=[];
const pending: Awaited<ReturnType<typeof captureReplica>>[]=[];
async function run(script:string,asOf:string) {
  await new Promise<void>((ok,fail)=>{
    const child=spawn(process.execPath,['--no-warnings',script],{env:{...process.env,
      BUILD_DATABASE_URL:url.toString(),BUILD_AS_OF:asOf,BUILD_HISTORY_CACHE:''},stdio:'inherit'});
    child.on('error',fail);child.on('close',code=>code===0?ok():fail(new Error(`${script} 실패 (${code})`)));
  });
}
try {
  await local.connect();
  const archived=await readManifest(store,config.frozen.manifest);
  assert(archived && await store.get(`verified/${archived.id.slice(10,-5)}.json`),'검증된 A 보관본 필요');
  for(const epoch of [...config.owners,...config.globals].filter(o=>o.source==='hist_a'))
    assert(epoch.to && Date.parse(epoch.to)<=Date.parse(archived.manifest.createdAt),'A 보관본이 담당 전환 시각까지 도달하지 못했습니다');
  await restore(local,archived.manifest,store);
  await local.query(`ALTER SCHEMA public RENAME TO hist_a; CREATE SCHEMA public;
    CREATE TABLE hist_a.collection_health(id bigint,checked_at timestamptz,last_collect_at timestamptz,gap_min numeric,stale_items integer,action text)`);
  for(const live of config.live) {
    assert(['hist_b','hist_c'].includes(live.schema));
    assert(['DATABASE_URL_B','DATABASE_URL_C'].includes(live.secret));
    // 정기 보관과 빌드가 겹쳐도 DB 조회 시각 이후의 보관본을 섞지 않는다.
    const archiveStore=projectArchiveStore(store,live.project), history=await readManifest(archiveStore);
    const connection=process.env[live.secret]!;
    assert.equal(new URL(connection).username,`postgres.${live.project}`);
    const source=new pg.Client({connectionString:connection,ssl,connectionTimeoutMillis:15000});sources.push(source);
    await source.connect();await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await source.query("SET LOCAL statement_timeout='120s'");
    const quality=await checkCandles(source as any);
    assert(!quality.stale && !quality.mismatches,`${live.schema} 집계 상태 불량`);
    const items=(await source.query('SELECT item_id FROM items WHERE tracked ORDER BY item_id')).rows.map(r=>r.item_id);
    assert.deepEqual(items,config.owners.filter(o=>o.source===live.schema && o.to===null).map(o=>o.itemId).sort(),'수집 담당 종목 불일치');
    const previous=await readReplica(store,live.project);
    // 최초 시간별 전환 때만 배포 중단 동안 누적된 변경분을 따라잡는다.
    const migrating=previous?.chunks.some(c=>c.table==='trades' && /^\d{4}-\d{2}-\d{2}$/.test(c.bucket));
    const captured=await captureReplica(source,store,live.project,
      !previous || migrating ? 20_000_000 : 6_000_000);
    await source.query('ROLLBACK');
    pending.push(captured);
    console.log(`[build-replica] ${live.schema}`,JSON.stringify(captured.stats),'결과 본문/해시 목록 기준, 청구량 아님');
    await local.query('BEGIN');
    await restoreReplica(local,store,captured.replica,`live_${live.schema}`);
    await local.query('COMMIT');
    if(history) {
      assert(await archiveStore.get(`verified/${history.id.slice(10,-5)}.json`),'새 DB 보관본 검증 기록 없음');
      assert(Date.parse(history.manifest.createdAt)<=Date.parse(captured.replica.asOf),'DB 조회 시각보다 새로운 보관본');
      assert(Date.parse(captured.replica.asOf)-Date.parse(history.manifest.createdAt)<6*86400000,'새 DB 보관 공백');
      await restore(local,history.manifest,archiveStore);
      await local.query(`ALTER SCHEMA public RENAME TO ${quote(live.schema)}; CREATE SCHEMA public`);
      for(const table of Object.keys(TABLES)) {
        const name=`${quote(live.schema)}.${quote(table)}`,fresh=`${quote(`live_${live.schema}`)}.${quote(table)}`;
        if(['trades','candles_1h','listing_snapshots','listing_deltas','legendary_card_floor','legendary_card_scans'].includes(table)) {
          const columns=captured.replica.columns[table].map(c=>c.name), keys=TABLES[table].key;
          await local.query(`INSERT INTO ${name}(${columns.map(quote).join(',')}) SELECT ${columns.map(quote).join(',')} FROM ${fresh}
            ON CONFLICT(${keys.map(quote).join(',')}) DO UPDATE SET ${columns.filter(c=>!keys.includes(c)).map(c=>`${quote(c)}=EXCLUDED.${quote(c)}`).join(',')}`);
        } else {
          await local.query(`TRUNCATE ${name}; INSERT INTO ${name} SELECT * FROM ${fresh}`);
        }
      }
      await local.query(`CREATE TABLE ${quote(live.schema)}.collection_health AS SELECT * FROM ${quote(`live_${live.schema}`)}.collection_health`);
    } else {
      const first=config.owners.filter(o=>o.source===live.schema).map(o=>Date.parse(o.from!));
      assert(first.length && Date.parse(captured.replica.asOf)-Math.min(...first)<6*86400000,'최초 보관 없이 6일을 넘겼습니다');
      await local.query(`ALTER SCHEMA ${quote(`live_${live.schema}`)} RENAME TO ${quote(live.schema)}`);
    }
  }
  const asOf=pending.map(p=>p.replica.asOf).sort()[0];
  await local.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const report=await unifyMarket(local,['hist_a',...config.live.map(s=>s.schema)],config.owners,asOf,config.globals);
  await local.query('COMMIT');
  // 발행 예측은 통합 이력으로 계산하되 저장은 전역 상태 담당 B에만 한다.
  assert.equal(new URL(process.env.DATABASE_URL!).username,`postgres.${config.live.find(s=>s.schema===config.globals.at(-1)!.source)!.project}`);
  await run('scripts/scan-turnover.ts',asOf);
  await run('scripts/record-forecasts.ts',asOf);
  const globalSource=sources[config.live.findIndex(s=>s.schema===config.globals.at(-1)!.source)];
  for(const table of ['research_forecast_batches','research_actuals','market_rankings']) {
    const rows=(await globalSource.query(`SELECT to_jsonb(t)::text AS row FROM ${quote(table)} t`)).rows;
    await local.query(`TRUNCATE ${quote(table)}`);
    await local.query(`INSERT INTO ${quote(table)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb)`,['['+rows.map(r=>r.row).join(',')+']']);
  }
  await run('web/build.ts',asOf);
  for(const p of pending) await publishReplica(store,p.replica,p.previous);
  console.log('[history-site]',JSON.stringify(report));
} finally {
  await local.query('ROLLBACK').catch(()=>{});await local.end();
  for(const source of sources) {await source.query('ROLLBACK').catch(()=>{});await source.end();}
}
