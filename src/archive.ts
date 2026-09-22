// 시세 보관 전용: 삭제된 운영 행은 보관본에 남기고, 같은 키의 수정은 최신 관측으로 갱신한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient, Client } from 'pg';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

type DB = PoolClient | Client;
type Definition = { key: string[]; time?: string; select?: string; source?: string };
export const TABLES: Record<string, Definition> = {
  items: { key: ['item_id'] },
  trades: { key: ['id'], time: 'sold_date' },
  candles_1h: { key: ['item_id', 'hour'], time: 'hour' },
  candle_pipeline_state: { key: ['singleton'] },
  listings: { key: ['auction_no'], time: 'first_seen_at' },
  listing_deltas: { key: ['id'], time: 'observed_at' },
  listing_snapshots: { key: ['id'], time: 'captured_at' },
  events: { key: ['id'] },
  legendary_card_floor: { key: ['id'], time: 'captured_at' },
  legendary_card_scans: { key: ['id'], time: 'started_at' },
  market_rankings: { key: ['captured_at', 'item_id'], time: 'captured_at' },
  research_forecast_batches: { key: ['version', 'origin'] },
  research_actuals: { key: ['version', 'target'] },
  // 오류 원문에는 API URL/키가 섞일 수 있다. 상태와 정량 기록만 허용한다.
  collection_quality: { key: ['id'], time: 'started_at', source: 'collection_runs', select: `
    id,item_id,source,started_at,finished_at,sold_rows,sold_new,sold_span_min,saturated,listing_rows,deltas_found,
    CASE WHEN error IS NOT NULL THEN 'failed' WHEN finished_at IS NULL THEN 'running' ELSE 'success' END AS status` },
};
const TYPES: Record<number, string> = { 16: 'boolean', 20: 'bigint', 23: 'integer', 25: 'text',
  700: 'real', 701: 'double precision', 1009: 'text[]', 1082: 'date', 1184: 'timestamp with time zone', 1700: 'numeric', 3802: 'jsonb' };
export type Row = { key: string; row: string };
export type Column = { name: string; type: string };
export type Shard = { table: string; day: string; hash: string; rows: number; bytes: number; sourceHash?: string };
export type Manifest = {
  format: 1; createdAt: string; revision: string | null; parent: string | null;
  qualityAvailableFrom: string | null; continuity: 'initial' | 'ok' | 'gap';
  columns: Record<string, Column[]>; shards: Shard[];
};
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const quote = (name: string) => { assert(/^[a-z_][a-z0-9_]*$/.test(name)); return `"${name}"`; };
export const keySQL = (table: string) => `jsonb_build_array(${TABLES[table].key.map(quote).join(',')})::text`;

export function encode(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  assert.equal(new Set(sorted.map(r => r.key)).size, sorted.length, '중복 키');
  return gzipSync(sorted.map(r => JSON.stringify(r) + '\n').join(''), { level: 6 });
}
export function decode(bytes: Buffer, shard: Shard): Row[] {
  assert.equal(hash(bytes), shard.hash, '보관 파일 SHA-256 불일치');
  assert.equal(bytes.length, shard.bytes, '보관 파일 크기 불일치');
  const text = gunzipSync(bytes).toString('utf8');
  const rows: Row[] = text ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
  assert.equal(rows.length, shard.rows, '보관 행 수 불일치');
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, '중복 키');
  for (const row of rows) { assert.equal(typeof row.row, 'string'); assert.equal(typeof row.key, 'string'); }
  return rows;
}
export function mergeRows(old: Row[], current: Row[]) {
  const rows = new Map(old.map(r => [r.key, r]));
  for (const row of current) rows.set(row.key, row);
  return [...rows.values()];
}
export interface Store { get(key: string): Promise<Buffer | null>; put(key: string, bytes: Buffer): Promise<void> }
export function projectArchiveStore(store: Store, project: string): Store {
  assert(/^[a-z]{20}$/.test(project));
  const prefix = `sources/${project}/`;
  return { get: key => store.get(prefix+key), put: (key,bytes) => store.put(prefix+key,bytes) };
}
export function localStore(root: string): Store {
  const path = (key: string) => { assert(/^[a-zA-Z0-9/_ .-]+$/.test(key) && !key.includes('..')); return join(root, key); };
  return {
    async get(key) { try { return await readFile(path(key)); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; } },
    async put(key, bytes) { const file = path(key); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, bytes); },
  };
}
export function r2Store(): Store {
  for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) assert(process.env[key], `${key} 필요`);
  const client = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  return {
    async get(key) {
      try { const r = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `research-v1/${key}` }));
        return Buffer.from(await r.Body!.transformToByteArray());
      } catch (e: any) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
    },
    async put(key, bytes) { await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `research-v1/${key}`, Body: bytes })); },
  };
}
export const objectKey = (shard: Shard) => `objects/${shard.hash}.jsonl.gz`;
export async function readRows(store: Store, shard: Shard) {
  const bytes = await store.get(objectKey(shard));
  assert(bytes, `보관 파일 누락: ${shard.table}/${shard.day}`);
  return decode(bytes, shard);
}
export function validateManifest(manifest: Manifest) {
  assert.equal(manifest.format, 1);
  assert(Number.isFinite(Date.parse(manifest.createdAt)));
  assert.deepEqual(Object.keys(manifest.columns).sort(), Object.keys(TABLES).sort());
  for (const cols of Object.values(manifest.columns)) for (const c of cols) { quote(c.name); assert(Object.values(TYPES).includes(c.type)); }
  const ids = new Set<string>();
  for (const s of manifest.shards) {
    assert(TABLES[s.table] && /^(all|\d{4}-\d{2}-\d{2})$/.test(s.day) && /^[a-f0-9]{64}$/.test(s.hash));
    assert(Number.isSafeInteger(s.rows) && s.rows > 0 && Number.isSafeInteger(s.bytes) && s.bytes > 0);
    const id = `${s.table}/${s.day}`; assert(!ids.has(id)); ids.add(id);
  }
}
export async function readManifest(store: Store, id?: string) {
  if (!id) {
    const latest = await store.get('latest.json');
    if (!latest) return null;
    id = JSON.parse(latest.toString()).manifest;
  }
  assert(id && /^manifests\/[a-f0-9]{64}\.json$/.test(id));
  const bytes = await store.get(id); assert(bytes, 'manifest 누락');
  assert.equal(`manifests/${hash(bytes)}.json`, id, 'manifest 훼손');
  const manifest: Manifest = JSON.parse(bytes.toString()); validateManifest(manifest);
  return { id, manifest };
}

// 호출자가 잡은 동일한 읽기 전용 스냅샷에서 전체 보존 행을 훑는다.
// ID 상한/수집시각만으로 자르면 늦게 커밋된 행과 오래된 백필을 놓칠 수 있다.
export async function capture(client: DB, store: Store, previous?: Manifest, maxFetchBytes = Infinity): Promise<Manifest> {
  assert(maxFetchBytes > 0, '추출 예산은 양수여야 합니다');
  await client.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'; SET LOCAL extra_float_digits=3");
  const at = (await client.query('SELECT now() AS at')).rows[0].at.toISOString();
  const manifest: Manifest = { format: 1, createdAt: at, revision: process.env.GITHUB_SHA ?? null,
    parent: null, qualityAvailableFrom: null, continuity: 'initial', columns: {}, shards: [] };
  const plans: { table: string; exported: string; signatures: any[]; changedDays: string[] }[] = [];
  let plannedBytes = 0;
  for (const [table, def] of Object.entries(TABLES)) {
    const query = `SELECT ${def.select ?? '*'} FROM public.${quote(def.source ?? table)}`;
    const fields = (await client.query(`${query} LIMIT 0`)).fields;
    manifest.columns[table] = fields.map(f => { assert(TYPES[f.dataTypeID], `지원하지 않는 자료형: ${table}.${f.name}`);
      return { name: f.name, type: TYPES[f.dataTypeID] }; });
    const day = def.time ? `to_char(${quote(def.time)} AT TIME ZONE 'UTC','YYYY-MM-DD')` : "'all'::text";
    const exported = `SELECT ${day} AS day, ${keySQL(table)} AS key, to_jsonb(t)::text AS row FROM (${query}) t`;
    // 비교를 DB 안에서 끝내야 매일 수백 MB의 원본을 전송하지 않는다.
    // 이전 소스 해시와 비교하므로 운영에서 삭제된 행이 보관본에 남아 있어도 중복 전송하지 않는다.
    const signatures = (await client.query(`SELECT day, COUNT(*)::int AS rows,
      SUM(octet_length(row)+octet_length(key)+octet_length(day)+32)::float8 AS bytes,
      encode(sha256(convert_to(string_agg(row || chr(10), '' ORDER BY key COLLATE "C"),'UTF8')),'hex') AS hash
      FROM (${exported}) e GROUP BY day ORDER BY day`)).rows;
    const changedDays: string[] = [];
    for (const sig of signatures) {
      const old = previous?.shards.find(s => s.table === table && s.day === sig.day);
      if (old?.sourceHash === sig.hash) manifest.shards.push(old);
      else { changedDays.push(sig.day); plannedBytes += sig.bytes; }
    }
    if (!changedDays.length) { console.log(`${table}: 변경 없음`); continue; }
    plans.push({ table, exported, signatures, changedDays });
  }
  // 원본을 한 행도 받기 전에 전체 변경량을 계산한다. 청구량이 아닌 결과 본문 예산이다.
  console.log(`[archive-plan] changedBodyBytes=${plannedBytes} maxFetchBytes=${maxFetchBytes}`);
  assert(plannedBytes <= maxFetchBytes, '보관 추출 예산 초과: 원본 다운로드 전에 중단');
  for (const { table, exported, signatures, changedDays } of plans) {
    await client.query(`DECLARE archive_cursor NO SCROLL CURSOR FOR SELECT * FROM (${exported}) exported
      WHERE day=ANY($1::text[]) ORDER BY day,key COLLATE "C"`, [changedDays]);
    let currentDay = '', rows: Row[] = [], count = 0;
    const flush = async () => {
      if (!rows.length) return;
      assert.equal(hash(rows.map(r => r.row + '\n').join('')), signatures.find(s => s.day === currentDay).hash,
        `DB 해시와 내려받은 원본 불일치: ${table}/${currentDay}`);
      const bytes = encode(rows);
      const shard = { table, day: currentDay, hash: hash(bytes), rows: rows.length, bytes: bytes.length,
        sourceHash: signatures.find(s => s.day === currentDay).hash };
      await store.put(objectKey(shard), bytes); manifest.shards.push(shard); rows = [];
    };
    while (true) {
      const batch = (await client.query('FETCH FORWARD 5000 FROM archive_cursor')).rows;
      if (!batch.length) break;
      for (const row of batch) {
        if (row.day !== currentDay) { await flush(); currentDay = row.day; }
        rows.push({ key: row.key, row: row.row }); count++;
      }
    }
    await flush(); await client.query('CLOSE archive_cursor');
    console.log(`${table}: ${count}행 저장`);
  }
  const quality = manifest.shards.filter(s => s.table === 'collection_quality').map(s => s.day).sort();
  manifest.qualityAvailableFrom = quality[0] ?? null;
  return manifest;
}

export async function combine(previous: Manifest | null, current: Manifest, oldStore: Store, newStore: Store, output: Store) {
  if (previous) assert.deepEqual(current.columns, previous.columns, '스키마 변경: 보관 형식 이전이 필요합니다');
  const shards = new Map((previous?.shards ?? []).map(s => [`${s.table}/${s.day}`, s]));
  for (const s of current.shards) {
    const id = `${s.table}/${s.day}`, old = shards.get(id);
    if (old?.hash === s.hash) { shards.set(id, s); continue; }
    const fresh = await readRows(newStore, s);
    const rows = old ? mergeRows(await readRows(oldStore, old), fresh) : fresh;
    const bytes = encode(rows), merged = { ...s, hash: hash(bytes), bytes: bytes.length, rows: rows.length };
    if (old?.hash !== merged.hash) {
      await output.put(objectKey(merged), bytes);
      // PUT 성공만으로 보관 성공이라 하지 않고 실제 다시 받은 바이트를 검사한다.
      await readRows(output, merged);
    }
    shards.set(id, merged);
  }
  // 최근 DB를 합치는 연구 조회에도 이미 알려진 보관 공백을 그대로 전달한다.
  const continuity = previous ? (previous.continuity === 'gap' ||
    Date.parse(current.createdAt) - Date.parse(previous.createdAt) > 6 * 86400000 ? 'gap' : 'ok') : 'initial';
  return { ...current, continuity: continuity as Manifest['continuity'],
    qualityAvailableFrom: previous?.qualityAvailableFrom ?? current.qualityAvailableFrom,
    shards: [...shards.values()].sort((a, b) => `${a.table}/${a.day}`.localeCompare(`${b.table}/${b.day}`)) };
}

export type Selection = { from?: string; to?: string; items?: string[] };
export function matches(table: string, row: Row, selection: Selection) {
  const value = JSON.parse(row.row), def = TABLES[table];
  // 전체 시장 지표/이벤트/모델 발행본은 개별 아이템으로 잘라 의미를 바꾸지 않는다.
  if (selection.items?.length && value.item_id && !selection.items.includes(value.item_id)) return false;
  if (!def.time) return true;
  const t = Date.parse(value[def.time]);
  const end = table === 'listings' ? Date.parse(value.closed_at ?? value.expire_date) : t;
  return (!selection.from || end >= Date.parse(selection.from)) && (!selection.to || t < Date.parse(selection.to));
}
export function selectShard(shard: Shard, selection: Selection) {
  if (shard.day === 'all') return true;
  const start = Date.parse(`${shard.day}T00:00:00Z`), end = start + 86400000;
  return (shard.table === 'listings' || !selection.from || end > Date.parse(selection.from)) &&
    (!selection.to || start < Date.parse(selection.to));
}

export async function restore(client: DB, manifest: Manifest, store: Store, selection: Selection = {}) {
  validateManifest(manifest);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'; SET LOCAL extra_float_digits=3");
    const existing = await client.query("SELECT 1 FROM pg_tables WHERE schemaname='public'");
    assert.equal(existing.rowCount, 0, '빈 분석용 DB에만 불러올 수 있습니다');
    for (const [table, cols] of Object.entries(manifest.columns)) {
      await client.query(`CREATE TABLE public.${quote(table)} (${cols.map(c => `${quote(c.name)} ${c.type}`).join(',')},
        PRIMARY KEY (${TABLES[table].key.map(quote).join(',')}))`);
    }
    let total = 0;
    for (const shard of manifest.shards.filter(s => selectShard(s, selection))) {
      const rows = (await readRows(store, shard)).filter(r => matches(shard.table, r, selection));
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000);
        // JSON 원문을 직접 PostgreSQL에 전달하여 JS Number의 정밀도 손실을 피한다.
        const result = await client.query(`INSERT INTO public.${quote(shard.table)} SELECT * FROM
          jsonb_populate_recordset(NULL::public.${quote(shard.table)},$1::jsonb)
          RETURNING ${keySQL(shard.table)} AS key,to_jsonb(${quote(shard.table)}.*)::text AS row`,
        ['[' + batch.map(r => r.row).join(',') + ']']);
        assert.equal(hash(encode(result.rows)), hash(encode(batch)), `실제 복원 내용 불일치: ${shard.table}`);
        total += batch.length;
      }
    }
    await client.query('COMMIT'); return total;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
