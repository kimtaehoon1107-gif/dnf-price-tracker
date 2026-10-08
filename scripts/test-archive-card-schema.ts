// 합성 JSON만 PostgreSQL에서 변환한다. 운영 테이블 조회/쓰기 및 DDL은 없다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { combine, encode, hash, readRows, upgradeCardArchive, type Manifest, type Store, type Row } from '../src/archive.ts';

const connectionString = process.env.ARCHIVE_VERIFY_URL ?? process.env.DATABASE_URL;
assert(connectionString, '검증용 PostgreSQL 연결 필요');
const local = new URL(connectionString).hostname === '127.0.0.1';
const client = new pg.Client({ connectionString, ssl: local ? false : {
  ca: readFileSync('certs/supabase-prod-ca-2021.crt', 'utf8'), rejectUnauthorized: true,
} });
const files = new Map<string, Buffer>(), migratedFiles = new Map<string, Buffer>();
const memory = (map: Map<string, Buffer>): Store => ({ get: async key => map.get(key) ?? null,
  put: async (key, value) => { map.set(key, value); } });
const oldStore = memory(files), output = memory(migratedFiles);
const table = 'legendary_card_floor';
const old: Row = { key: '[9007199254740993]', row: '{"id": 9007199254740993, "price": 9007199254740995}' };
const bytes = encode([old]);
const shard = { table, day: '2026-09-20', hash: hash(bytes), bytes: bytes.length, rows: 1 };
files.set(`objects/${shard.hash}.jsonl.gz`, bytes);
const previous: Manifest = { format: 1, createdAt: '2026-10-01T00:00:00Z', revision: null, parent: null,
  qualityAvailableFrom: null, continuity: 'ok', columns: { [table]: [{ name: 'id', type: 'bigint' }, { name: 'price', type: 'numeric' }] },
  shards: [shard] };
const current: Manifest = { ...previous, createdAt: '2026-10-02T00:00:00Z', shards: [],
  columns: { [table]: [...previous.columns[table], { name: 'cheapest10', type: 'jsonb' }] } };
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const result = await combine(previous, current, oldStore, output, output, client);
  const rows = await readRows(output, result.shards[0]);
  assert.equal(rows[0].row, '{"id": 9007199254740993, "price": 9007199254740995, "cheapest10": null}');
  assert.deepEqual(await readRows(oldStore, shard), [old], '구형 객체 불변');
  assert.deepEqual(result.columns, current.columns, '운영에서 이미 정리된 날짜도 새 형식으로 복원 가능');
  assert.equal(await upgradeCardArchive(result, current, output, output, client), result, '재실행은 이전 생략');
  const fresh = { key: old.key, row: '{"id": 9007199254740993, "price": 9007199254740995, "cheapest10": [{"unitPrice": 900000}]}' };
  const freshBytes = encode([fresh]), freshShard = { ...shard, hash: hash(freshBytes), bytes: freshBytes.length };
  migratedFiles.set(`objects/${freshShard.hash}.jsonl.gz`, freshBytes);
  const updated = await combine(previous, { ...current, shards: [freshShard] }, oldStore, output, output, client);
  assert.deepEqual(await readRows(output, updated.shards[0]), [fresh], '새 관측 cheapest10 보존');
  const count = migratedFiles.size;
  for (const columns of [previous.columns, { [table]: [{ name: 'id', type: 'text' }, ...current.columns[table].slice(1)] }]) {
    await assert.rejects(() => upgradeCardArchive(result, { ...current, columns }, output, output, client), /스키마/);
  }
  assert.equal(migratedFiles.size, count, '열 삭제/자료형 변경은 쓰기 전에 거부');
  console.log('카드 보관 형식 이전 통과: 큰 정수 정밀도·구형 객체 보존·과거 날짜·새 관측·재실행·미지원 변경 거부');
} finally { await client.query('ROLLBACK'); await client.end(); }
