// 제한된 과거 시간봉을 읽기만 한다. 오류 원문/연결 문자열은 출력하지 않는다.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {liveProjects,liveClient} from '../src/live-projects.ts';
const out=process.argv[2]??'data/d-note-study-20261103';
assert(!existsSync(out),'기존 입력 폴더를 덮어쓰지 않습니다');
const base='https://kimtaehoon1107-gif.github.io/dnf-price-tracker/data/';
async function get(path:string) {const r=await fetch(base+path,{cache:'no-store'});assert(r.ok,`공개 자료 HTTP ${r.status}`);return r.text();}
const summaryText=await get('summary.json'),summary=JSON.parse(summaryText);
const items=summary.items.filter((x:any)=>x.price_basis==='trade').map((x:any)=>({id:x.item_id,name:x.item_name,category:x.category}));
const from='2026-09-28T10:00:00Z',through='2026-10-28T10:00:00Z',sources=[];
for(const source of liveProjects()) {
  const client=liveClient(source.connectionString);
  try {
    await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='25s'");
    const ids=items.filter((x:any)=>source.ids?.includes(x.id)).map((x:any)=>x.id);
    const snapshot=(await client.query('SELECT now() as read_at,raw_from,raw_max_id,refreshed_at FROM candle_pipeline_state WHERE singleton')).rows[0];
    assert(Date.parse(snapshot.refreshed_at)>=Date.parse(through),'집계가 분석 종료보다 오래됐습니다');
    const rows=(await client.query(`SELECT item_id,hour,vwap::float8,qty,n,raw_complete FROM candles_1h
      WHERE item_id=ANY($1) AND hour>=$2 AND hour<$3 ORDER BY item_id,hour`,[ids,from,through])).rows;
    const events=source.name==='hist_b'?(await client.query('SELECT id,name,type,announced_at,starts_at,ends_at,related_item_ids,source_url FROM events ORDER BY id')).rows:[];
    sources.push({name:source.name,ids,snapshot,rows,events});
    await client.query('ROLLBACK');
  } catch {throw new Error(`${source.name} 읽기 전용 입력 확보 실패 (오류 원문은 비공개)`);}
  finally {await client.end();}
}
assert.equal(new Set(sources.flatMap(s=>s.ids)).size,items.length,'담당 누락/중복');
assert.equal(await get('summary.json'),summaryText,'조회 중 공개 빌드 변경: 재실행 필요');
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
mkdirSync(out,{recursive:true});writeFileSync(`${out}/summary.json`,summaryText);
writeFileSync(`${out}/input.json.gz`,gzipSync(JSON.stringify({format:1,from,through,revision,items,sources})));
console.log(JSON.stringify({out,items:items.length,rows:sources.map(s=>({source:s.name,n:s.rows.length})),revision}));
