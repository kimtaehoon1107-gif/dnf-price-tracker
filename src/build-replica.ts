// 빌드용 현재 행 집합. 연구 보관본과 달리 삭제도 반영하고 DB별 경로를 분리한다.
// 단순 MAX(id) 증분은 늦게 커밋된 작은 ID를 놓치므로 작은 묶음의 내용 해시를 대조한다.
import assert from 'node:assert/strict';
import type { Client, PoolClient } from 'pg';
import { encode, decode, hash, quote, TABLES, type Row, type Column, type Store } from './archive.ts';

type DB = Client | PoolClient;
type Definition = { key: string[]; bucket: string; select?: string; source?: string };
const DEFINITIONS: Record<string, Definition> = Object.fromEntries(Object.entries(TABLES).map(([name, def]) => [name, {
  ...def,
  bucket: def.key.length === 1 && def.key[0] === 'id' ? '(id/256)::text' :
    def.time ? `to_char(${quote(def.time)} AT TIME ZONE 'UTC','YYYY-MM-DD')` : "'all'::text",
}]));
// 체결 ID는 중복 INSERT에도 증가한다. 시간별로 묶어 완료된 시간을 재사용한다.
const hourlyTimes:Record<string,string>={trades:'sold_date',legendary_card_scans:'started_at'};
for(const [table,time] of Object.entries(hourlyTimes))
  DEFINITIONS[table].bucket = `to_char(${time} AT TIME ZONE 'UTC','YYYY-MM-DD/HH24')`;
// 호가 사다리는 현재 매물만 사용한다. 닫힌 매물 전체를 매시간 가져오지 않는다.
DEFINITIONS.listings = { key: ['auction_no'], bucket: "'all'::text",
  select: '*', source: 'listings WHERE closed_at IS NULL' };
DEFINITIONS.collection_health = { key: ['id'], bucket: '(id/256)::text',
  select: 'id,checked_at,last_collect_at,gap_min,stale_items,action', source: 'collection_health' };
const TYPES: Record<number, string> = { 16: 'boolean', 20: 'bigint', 23: 'integer', 25: 'text',
  700: 'real', 701: 'double precision', 1009: 'text[]', 1082: 'date', 1184: 'timestamp with time zone', 1700: 'numeric', 3802: 'jsonb' };
type Chunk = { table: string; bucket: string; hash: string; sourceHash: string; rows: number; bytes: number };
export type Replica = { format: 1; project: string; asOf: string; columns: Record<string, Column[]>; chunks: Chunk[] };
const objectKey = (c: Chunk) => `build-replica/objects/${c.hash}.jsonl.gz`;
const rootKey = (project: string) => { assert(/^[a-z]{20}$/.test(project)); return `build-replica/${project}/latest.json`; };
const digest = (rows: Row[]) => hash([...rows].sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(r => r.row+'\n').join(''));

export async function readReplica(store: Store, project: string): Promise<Replica | null> {
  const bytes = await store.get(rootKey(project));
  if (!bytes) return null;
  const pointer = JSON.parse(bytes.toString());
  assert(/^build-replica\/manifests\/[a-f0-9]{64}\.json$/.test(pointer.manifest));
  const raw = await store.get(pointer.manifest); assert(raw, '빌드 복제본 manifest 누락');
  assert.equal(pointer.manifest, `build-replica/manifests/${hash(raw)}.json`);
  const replica: Replica = JSON.parse(raw.toString());
  assert.equal(replica.format, 1); assert.equal(replica.project, project);
  assert(Number.isFinite(Date.parse(replica.asOf)));
  assert.deepEqual(Object.keys(replica.columns).sort(), Object.keys(DEFINITIONS).sort());
  const seen = new Set<string>();
  for (const chunk of replica.chunks) {
    assert(DEFINITIONS[chunk.table] && /^[a-f0-9]{64}$/.test(chunk.hash) && /^[a-f0-9]{64}$/.test(chunk.sourceHash));
    assert(Number.isSafeInteger(chunk.rows) && chunk.rows > 0 && Number.isSafeInteger(chunk.bytes) && chunk.bytes > 0);
    const key = `${chunk.table}/${chunk.bucket}`; assert(!seen.has(key)); seen.add(key);
  }
  return replica;
}

/** 호출자가 연 REPEATABLE READ READ ONLY 스냅샷에서 준비한다. latest 갱신은 복원 검사 뒤 별도로 한다. */
export async function captureReplica(client: DB, store: Store, project: string, byteBudget: number) {
  rootKey(project);
  assert(Number.isSafeInteger(byteBudget) && byteBudget > 0);
  assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  await client.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'; SET LOCAL extra_float_digits=3");
  const previous = await readReplica(store, project);
  const reusable = [...previous?.chunks ?? []];
  // 구형 날짜/ID 묶음은 R2 안에서 시간별로 나눈다. 운영 DB 전체를 다시 받지 않는다.
  for (const chunk of reusable.filter(c=>hourlyTimes[c.table] && !c.bucket.includes('/'))) {
    const raw=await store.get(objectKey(chunk)); assert(raw,'재사용할 빌드 복제본 객체가 없습니다');
    const rows=decode(raw,{...chunk,day:chunk.bucket});
    assert.equal(digest(rows),chunk.sourceHash);
    const hours=new Map<string,Row[]>();
    for(const row of rows) {
      const bucket=new Date(JSON.parse(row.row)[hourlyTimes[chunk.table]]).toISOString().slice(0,13).replace('T','/');
      const group=hours.get(bucket)??[];group.push(row);hours.set(bucket,group);
    }
    for(const [bucket,group] of hours) {
      const bytes=encode(group),part={...chunk,bucket,hash:hash(bytes),sourceHash:digest(group),rows:group.length,bytes:bytes.length};
      await store.put(objectKey(part),bytes);reusable.push(part);
    }
  }
  const replica: Replica = { format: 1, project, asOf: (await client.query('SELECT now() AS t')).rows[0].t.toISOString(), columns: {}, chunks: [] };
  const stats = { fetchedBytes: 0, signatureBytes: 0, fetchedChunks: 0, reusedChunks: 0 };
  const plans: { table: string; sql: string; signatures: any[]; fields: Column[] }[] = [];
  // 모든 테이블의 계획을 먼저 계산해 예산 초과면 원문 조회 전에 중단한다.
  for (const [table, def] of Object.entries(DEFINITIONS)) {
    const source = def.source ?? quote(table);
    const query = `SELECT ${def.select ?? '*'} FROM public.${source}`;
    const fields = (await client.query(`${query} LIMIT 0`)).fields.map(f => {
      assert(TYPES[f.dataTypeID], `지원하지 않는 자료형: ${table}.${f.name}`);
      return { name: f.name, type: TYPES[f.dataTypeID] };
    });
    replica.columns[table] = fields;
    const key = `jsonb_build_array(${def.key.map(quote).join(',')})::text`;
    const sql = `SELECT ${def.bucket} AS bucket,${key} AS key,to_jsonb(t)::text AS row FROM (${query}) t`;
    const signatures = (await client.query(`SELECT bucket,count(*)::int AS rows,
      sum(octet_length(row)+octet_length(key))::int AS bytes,
      encode(sha256(convert_to(string_agg(row||chr(10),'' ORDER BY key COLLATE "C"),'UTF8')),'hex') AS hash
      FROM (${sql}) r GROUP BY bucket ORDER BY bucket`)).rows;
    stats.signatureBytes += Buffer.byteLength(JSON.stringify(signatures));
    const missing = signatures.filter(sig => {
      const old = reusable.find(c => c.table === table && c.bucket === sig.bucket && c.sourceHash === sig.hash);
      if (old && JSON.stringify(previous!.columns[table]) === JSON.stringify(fields)) {
        replica.chunks.push(old); stats.reusedChunks++; return false;
      }
      return true;
    });
    stats.fetchedBytes += missing.reduce((n,s) => n+s.bytes, 0);
    console.log(`[build-replica-plan] ${table} changedBytes=${missing.reduce((n,s)=>n+s.bytes,0)} changedChunks=${missing.length}`);
    plans.push({ table, sql, signatures: missing, fields });
  }
  assert(stats.fetchedBytes + stats.signatureBytes <= byteBudget,
    `빌드 복제본 전송 예산 초과: 본문 ${stats.fetchedBytes} + 해시 목록 ${stats.signatureBytes} > ${byteBudget} bytes`);
  const uploads: { key: string; bytes: Buffer }[] = [];
  const upload = async () => {
    const results=await Promise.allSettled(uploads.splice(0).map(o=>store.put(o.key,o.bytes)));
    for(const result of results) if(result.status==='rejected') throw result.reason;
  };
  for (const { table, sql, signatures } of plans) {
    if (!signatures.length) continue;
    await client.query(`DECLARE replica_rows NO SCROLL CURSOR FOR SELECT * FROM (${sql}) r
      WHERE bucket=ANY($1::text[]) ORDER BY bucket,key COLLATE "C"`, [signatures.map(s => s.bucket)]);
    let bucket = '', rows: Row[] = [];
    const flush = async () => {
      if (!rows.length) return;
      const sig = signatures.find(s => s.bucket === bucket)!;
      assert.equal(rows.length, sig.rows); assert.equal(digest(rows), sig.hash);
      const bytes = encode(rows);
      const chunk = { table, bucket, hash: hash(bytes), sourceHash: sig.hash, rows: rows.length, bytes: bytes.length };
      uploads.push({key:objectKey(chunk),bytes}); replica.chunks.push(chunk); stats.fetchedChunks++; rows = [];
      if(uploads.length===8) await upload();
    };
    try {
      while (true) {
        const batch = (await client.query('FETCH FORWARD 1000 FROM replica_rows')).rows;
        if (!batch.length) break;
        for (const row of batch) {
          if (bucket !== row.bucket) { await flush(); bucket = row.bucket; }
          rows.push({ key: row.key, row: row.row });
        }
      }
      await flush();
    } finally { await client.query('CLOSE replica_rows'); }
  }
  await upload();
  return { replica, stats, previous };
}

/** 호출자가 격리한 임시 Postgres에 복원한다. 기존 스키마를 덮어쓰지 않고 실제 삽입 내용까지 대조한다. */
export async function restoreReplica(client: DB, store: Store, replica: Replica, schema: string) {
  quote(schema);
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  for (const [table, fields] of Object.entries(replica.columns)) {
    assert(DEFINITIONS[table]);
    for (const f of fields) assert(Object.values(TYPES).includes(f.type));
    await client.query(`CREATE TABLE ${quote(schema)}.${quote(table)}
      (${fields.map(f => `${quote(f.name)} ${f.type}`).join(',')}, PRIMARY KEY (${DEFINITIONS[table].key.map(quote).join(',')}))`);
  }
  // 네트워크 대기는 작은 묶음으로 병렬화하고 실제 INSERT·내용 대조는 한 연결에서 순서대로 한다.
  for(let start=0;start<replica.chunks.length;start+=8) {
    const batch=replica.chunks.slice(start,start+8);
    const payloads=await Promise.all(batch.map(chunk=>store.get(objectKey(chunk))));
    for(const [index,chunk] of batch.entries()) {
    const bytes=payloads[index]; assert(bytes, '재사용할 빌드 복제본 객체가 없습니다');
    const rows = decode(bytes, { ...chunk, day: chunk.bucket });
    const table = `${quote(schema)}.${quote(chunk.table)}`;
    const restored: Row[] = [];
    for (let i=0; i<rows.length; i+=1000) {
      const result = await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)
        RETURNING jsonb_build_array(${DEFINITIONS[chunk.table].key.map(quote).join(',')})::text AS key,
        to_jsonb(${quote(chunk.table)}.*)::text AS row`, ['['+rows.slice(i,i+1000).map(r => r.row).join(',')+']']);
      restored.push(...result.rows);
    }
    assert.equal(digest(restored), chunk.sourceHash, `빌드 복제본 실제 복원 불일치: ${chunk.table}`);
    }
  }
}

// 호출자는 같은 프로젝트의 발행을 직렬화하고, 복원·통합 검증 성공 뒤에만 호출한다.
export async function publishReplica(store: Store, replica: Replica, previous: Replica | null) {
  assert.deepEqual(await readReplica(store, replica.project), previous, '다른 빌드가 복제본을 갱신했습니다');
  if (previous) assert(Date.parse(replica.asOf) > Date.parse(previous.asOf));
  const bytes = Buffer.from(JSON.stringify(replica));
  const manifest = `build-replica/manifests/${hash(bytes)}.json`;
  await store.put(manifest, bytes);
  await store.put(rootKey(replica.project), Buffer.from(JSON.stringify({ manifest })));
}
