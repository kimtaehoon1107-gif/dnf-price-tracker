// 원본은 SELECT만 사용한다. 세션 임시 복사본에서만 인덱스를 제거해 비교한다.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {liveProjects,liveClient} from '../src/live-projects.ts';

const digest=(rows:unknown)=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const queries=['src/research-data.ts','src/research-export.ts','src/seasonal-export.ts'].map(file=>{
  const matches=[...readFileSync(file,'utf8').matchAll(/`([^`]*listing_snapshots[^`]*)`/gs)];
  assert.equal(matches.length,1,file);
  return {name:file,sql:matches[0][1].replace("${legacy ? 'AND s.min_unit_price>0' : ''}",'')};
});
queries.push({name:'archive daily signatures',sql:`SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
  count(*)::int AS rows,encode(sha256(convert_to(string_agg(to_jsonb(s)::text || chr(10),'' ORDER BY jsonb_build_array(id)::text COLLATE "C"),'UTF8')),'hex') AS hash
  FROM listing_snapshots s GROUP BY 1 ORDER BY 1`});
const report={at:new Date().toISOString(),method:'same-session temporary clone; with/without/with-again, five warm EXPLAIN ANALYZE runs; no permanent row writes',sources:[] as any[]};
const output=process.argv[2];
assert(output,'새 결과 폴더 경로를 지정하세요');
assert(!existsSync(output),'기존 검증 결과는 덮어쓰지 않습니다');
mkdirSync(output,{recursive:true});
for(const source of liveProjects()) {
  const c=liveClient(source.connectionString);
  try {
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query("SET LOCAL statement_timeout='25s'; SET LOCAL lock_timeout='2s'");
    const indexes=(await c.query(`SELECT indexname,indexdef,pg_relation_size(indexname::regclass)::text bytes
      FROM pg_indexes WHERE schemaname='public' AND tablename='listing_snapshots' ORDER BY indexname`)).rows;
    const meta=(await c.query(`SELECT count(*)::int rows,max(id)::text max_id,now() as_of,
      md5(string_agg(md5(s::text),'' ORDER BY id)) fingerprint FROM public.listing_snapshots s`)).rows[0];
    await c.query(`CREATE TEMP TABLE listing_snapshots (LIKE public.listing_snapshots) ON COMMIT DROP;
      INSERT INTO pg_temp.listing_snapshots SELECT * FROM public.listing_snapshots;
      CREATE UNIQUE INDEX audit_pk ON pg_temp.listing_snapshots(id);
      CREATE UNIQUE INDEX audit_unique ON pg_temp.listing_snapshots(item_id,captured_at,COALESCE(upgrade,-1));
      CREATE INDEX audit_aux ON pg_temp.listing_snapshots(item_id,upgrade,captured_at DESC);
      ANALYZE pg_temp.listing_snapshots`);
    const copy=(await c.query(`SELECT count(*)::int rows,md5(string_agg(md5(s::text),'' ORDER BY id)) fingerprint FROM pg_temp.listing_snapshots s`)).rows[0];
    assert.equal(copy.rows,meta.rows); assert.equal(copy.fingerprint,meta.fingerprint);
    const before=new Date(new Date(meta.as_of).getTime()+86400000).toISOString().slice(0,10);
    const cases=queries.map(q=>({...q,params:q.name.startsWith('archive')?[]:q.name.includes('research-export')?['e974d2eac46f0c8b23b83d4da389fa57',before]:q.name.includes('research-data')?[before]:[meta.as_of]}));
    const groups=(await c.query('SELECT DISTINCT item_id,upgrade FROM pg_temp.listing_snapshots ORDER BY item_id,upgrade')).rows;
    const plans:any[]=[];
    for(const mode of ['with','without','with-again']) {
      if(mode==='without') await c.query('DROP INDEX pg_temp.audit_aux');
      if(mode==='with-again') await c.query('CREATE INDEX audit_aux ON pg_temp.listing_snapshots(item_id,upgrade,captured_at DESC)');
      const results=[];
      for(const q of cases) {
        const hash=digest((await c.query(q.sql,q.params)).rows);
        const runs=[];
        for(let n=0;n<5;n++) runs.push((await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.params)).rows[0]['QUERY PLAN'][0]);
        results.push({name:q.name,hash,medianMs:runs.map(p=>p['Execution Time']).sort((a,b)=>a-b)[2],runs});
      }
      const latest=[];
      for(const g of groups) {
        const latestSql=`SELECT * FROM listing_snapshots WHERE item_id=$1 AND ${g.upgrade===null?'upgrade IS NULL':'upgrade=$2::int'} ORDER BY captured_at DESC LIMIT 1`;
        const params=g.upgrade===null?[g.item_id]:[g.item_id,g.upgrade];
        const plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+latestSql,params)).rows[0]['QUERY PLAN'][0];
        latest.push({...g,hash:digest((await c.query(latestSql,params)).rows),ms:plan['Execution Time'],plan});
      }
      plans.push({mode,results,latest});
    }
    for(let i=0;i<cases.length;i++) assert.equal(plans[0].results[i].hash,plans[1].results[i].hash);
    for(let i=0;i<groups.length;i++) assert.equal(plans[0].latest[i].hash,plans[1].latest[i].hash);
    for(let i=0;i<cases.length;i++) assert.equal(plans[0].results[i].hash,plans[2].results[i].hash);
    for(let i=0;i<groups.length;i++) assert.equal(plans[0].latest[i].hash,plans[2].latest[i].hash);
    const entry={source:source.name,indexes,meta,plans}; report.sources.push(entry);
    writeFileSync(`${output}/benchmark.json`,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({source:source.name,rows:meta.rows,indexes,queries:plans.map(p=>({mode:p.mode,results:p.results.map(({name,medianMs}:any)=>({name,medianMs})),latestCount:p.latest.length,latestMaxMs:Math.max(...p.latest.map((r:any)=>r.ms))}))}));
    await c.query('ROLLBACK');
  } finally {await c.end();}
}
