import assert from 'node:assert/strict';
import { encode, decode, hash, mergeRows, matches, selectShard, combine, readRows,
  type Store, type Row, type Manifest } from '../src/archive.ts';

const row = (key: string, value: string): Row => ({ key, row: value });
const a = row('[1]', '{"id": 1, "unit_price": 9007199254740993, "sold_date": "2026-09-19T15:00:00.123456+00:00"}');
const b = row('[2]', '{"id": 2, "invalidated_at": null}');
const changed = row('[2]', '{"id": 2, "invalidated_at": "2026-09-20T00:00:00+00:00"}');
const late = row('[3]', '{"id": 3, "sold_date": "2026-08-25T00:00:00+00:00"}');
const bytes = encode([b, a]);
const shard = { table: 'trades', day: '2026-09-19', hash: hash(bytes), bytes: bytes.length, rows: 2 };
assert.deepEqual(decode(bytes, shard), [a, b]);
assert(decode(bytes, shard)[0].row.includes('9007199254740993'));
assert(decode(bytes, shard)[0].row.includes('.123456'));
const broken = Buffer.from(bytes); broken[10] ^= 1;
assert.throws(() => decode(broken, shard), /SHA-256/);
assert.throws(() => encode([a, a]), /중복/);
assert.deepEqual(mergeRows([a, b], [changed, late]), [a, changed, late], '정리된 행은 보존하고 수정·늦은 백필 반영');
assert.deepEqual(mergeRows(mergeRows([a, b], [changed, late]), [changed, late]), [a, changed, late], '재실행 중복 없음');
assert(matches('trades', a, { from: '2026-09-20T00:00:00+09:00', to: '2026-09-21T00:00:00+09:00' }));
assert(!matches('trades', a, { to: '2026-09-20T00:00:00+09:00' }), '끝 경계 제외');
assert(matches('listings', row('[1]', '{"first_seen_at":"2026-09-10T00:00:00Z","closed_at":"2026-09-20T00:00:00Z"}'),
  { from: '2026-09-19T00:00:00Z' }), '구간 시작 전부터 열린 매물 포함');
assert(!matches('trades', row('[1]', '{"item_id":"a","sold_date":"2026-09-20T00:00:00Z"}'), { items: ['b'] }));
assert(selectShard(shard, { from: '2026-09-20T00:00:00+09:00' }), 'KST 날짜의 이전 UTC 파티션 포함');

const files = new Map<string, Buffer>(); let puts = 0;
const store: Store = { get: async key => files.get(key) ?? null, put: async (key, value) => { puts++; files.set(key, value); } };
const manifest: Manifest = { format: 1, createdAt: '2026-09-20T00:00:00Z', revision: null, parent: null,
  qualityAvailableFrom: null, continuity: 'initial', columns: {}, shards: [shard] };
await store.put(`objects/${shard.hash}.jsonl.gz`, bytes);
puts = 0;
await combine(manifest, manifest, store, store, store);
assert.equal(puts, 0, '변경 없는 파티션은 다시 올리지 않음');
assert.equal((await combine({ ...manifest, continuity: 'gap' }, manifest, store, store, store)).continuity,
  'gap', '최근 DB를 합쳐도 이미 알려진 품질 공백은 사라지지 않음');
assert.equal((await combine(manifest, { ...manifest, createdAt: '2026-09-27T00:00:00Z' }, store, store, store)).continuity,
  'gap', '7일 정리보다 긴 보관 공백 표시');
const nextBytes = encode([changed, late]);
const nextShard = { ...shard, hash: hash(nextBytes), bytes: nextBytes.length };
await store.put(`objects/${nextShard.hash}.jsonl.gz`, nextBytes);
const merged = await combine(manifest, { ...manifest, shards: [nextShard] }, store, store, store);
assert.deepEqual(await readRows(store, merged.shards[0]), [a, changed, late]);
const missing: Store = { ...store, get: async () => null };
await assert.rejects(() => combine(manifest, { ...manifest, shards: [nextShard] }, missing, store, store), /누락/);
await assert.rejects(() => combine(manifest, { ...manifest, columns: { changed: [] } }, store, store, store), /스키마/);
console.log('보관 테스트 통과: 정밀도·훼손·중복·수정·백필·정리 후 보존·기간/아이템 선택·재실행');
