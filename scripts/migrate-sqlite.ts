// SQLite(data/dnf.db)에 쌓인 데이터를 Supabase/Postgres로 한 번 옮긴다.
//
// Phase 0에서 로컬 SQLite로 수집을 먼저 시작했기 때문에 필요한 일회성 스크립트다.
// 옮긴 뒤에는 Postgres 단일 백엔드로 간다.
//
//   node --env-file=.env --experimental-sqlite --no-warnings scripts/migrate-sqlite.ts
//
// 여러 번 실행해도 안전하다(전부 ON CONFLICT DO NOTHING). items는 init-db가
// 먼저 채우므로 여기서는 건드리지 않는다.

import { DatabaseSync } from 'node:sqlite';
import { query, pool } from '../src/db.ts';

const path = process.env.SQLITE_PATH ?? 'data/dnf.db';
const lite = new DatabaseSync(path, { readOnly: true });

const known = new Set((await query<{ item_id: string }>('SELECT item_id FROM items')).rows.map((r) => r.item_id));
console.log(`Postgres에 등록된 아이템 ${known.size}종\n`);

const CHUNK = 500;
const chunks = <T>(a: T[]) => Array.from({ length: Math.ceil(a.length / CHUNK) },
  (_, i) => a.slice(i * CHUNK, i * CHUNK + CHUNK));

// ── trades ───────────────────────────────────────────────────
const trades = (lite.prepare(`
  SELECT item_id, sold_date, unit_price, count, price, reinforce, refine, amplification_name, dup_seq
  FROM trades`).all() as Array<Record<string, string | number | null>>)
  .filter((r) => known.has(r.item_id as string));

let tn = 0;
for (const c of chunks(trades)) {
  const r = await query(`
    INSERT INTO trades (item_id, sold_date, unit_price, count, price, reinforce, refine, amplification_name, dup_seq)
    SELECT * FROM UNNEST($1::text[], $2::timestamptz[], $3::bigint[], $4::int[], $5::bigint[], $6::int[], $7::int[], $8::text[], $9::int[])
    ON CONFLICT DO NOTHING`,
    [c.map((x) => x.item_id), c.map((x) => x.sold_date), c.map((x) => x.unit_price), c.map((x) => x.count),
     c.map((x) => x.price), c.map((x) => x.reinforce), c.map((x) => x.refine),
     c.map((x) => x.amplification_name), c.map((x) => x.dup_seq)]);
  tn += r.rowCount ?? 0;
}
console.log(`trades            ${trades.length}행 중 ${tn}행 이관`);

// ── listings ─────────────────────────────────────────────────
const listings = (lite.prepare('SELECT * FROM listings').all() as Array<Record<string, string | number | null>>)
  .filter((r) => known.has(r.item_id as string));
let ln = 0;
for (const c of chunks(listings)) {
  const r = await query(`
    INSERT INTO listings (auction_no, item_id, reg_date, expire_date, unit_price, reg_count, cur_count, reinforce, first_seen_at, last_seen_at, closed_at)
    SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::bigint[], $6::int[], $7::int[], $8::int[], $9::timestamptz[], $10::timestamptz[], $11::timestamptz[])
    ON CONFLICT (auction_no) DO NOTHING`,
    [c.map((x) => x.auction_no), c.map((x) => x.item_id), c.map((x) => x.reg_date), c.map((x) => x.expire_date),
     c.map((x) => x.unit_price), c.map((x) => x.reg_count), c.map((x) => x.cur_count), c.map((x) => x.reinforce),
     c.map((x) => x.first_seen_at), c.map((x) => x.last_seen_at), c.map((x) => x.closed_at)]);
  ln += r.rowCount ?? 0;
}
console.log(`listings          ${listings.length}행 중 ${ln}행 이관`);

// ── listing_deltas ───────────────────────────────────────────
const deltas = (lite.prepare('SELECT * FROM listing_deltas').all() as Array<Record<string, string | number | null>>)
  .filter((r) => known.has(r.item_id as string));
for (const c of chunks(deltas)) {
  await query(`
    INSERT INTO listing_deltas (auction_no, item_id, unit_price, qty_sold, prev_count, new_count, observed_at, reason)
    SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::bigint[], $4::int[], $5::int[], $6::int[], $7::timestamptz[], $8::text[])`,
    [c.map((x) => x.auction_no), c.map((x) => x.item_id), c.map((x) => x.unit_price), c.map((x) => x.qty_sold),
     c.map((x) => x.prev_count), c.map((x) => x.new_count), c.map((x) => x.observed_at), c.map((x) => x.reason)]);
}
console.log(`listing_deltas    ${deltas.length}행 이관`);

// ── listing_snapshots ────────────────────────────────────────
const snaps = (lite.prepare('SELECT * FROM listing_snapshots').all() as Array<Record<string, string | number | null>>)
  .filter((r) => known.has(r.item_id as string));
for (const c of chunks(snaps)) {
  await query(`
    INSERT INTO listing_snapshots (item_id, captured_at, min_unit_price, p10, p25, median, listing_count, total_qty)
    SELECT * FROM UNNEST($1::text[], $2::timestamptz[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::int[], $8::int[])
    ON CONFLICT DO NOTHING`,
    [c.map((x) => x.item_id), c.map((x) => x.captured_at), c.map((x) => x.min_unit_price), c.map((x) => x.p10),
     c.map((x) => x.p25), c.map((x) => x.median), c.map((x) => x.listing_count), c.map((x) => x.total_qty)]);
}
console.log(`listing_snapshots ${snaps.length}행 이관`);

// ── events ───────────────────────────────────────────────────
const events = lite.prepare('SELECT * FROM events').all() as Array<Record<string, string | null>>;
for (const e of events) {
  await query(`
    INSERT INTO events (name, type, announced_at, starts_at, ends_at, related_item_ids, source_url, note)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8
    WHERE NOT EXISTS (SELECT 1 FROM events WHERE name = $1 AND starts_at = $4::timestamptz)`,
    [e.name, e.type, e.announced_at, e.starts_at, e.ends_at,
     e.related_item_ids ? JSON.parse(e.related_item_ids) : null, e.source_url, e.note]);
}
console.log(`events            ${events.length}행 이관`);

const after = await query<{ n: number; lo: Date; hi: Date }>(
  'SELECT COUNT(*)::int AS n, MIN(sold_date) AS lo, MAX(sold_date) AS hi FROM trades');
console.log(`\nPostgres 체결 ${after.rows[0].n.toLocaleString()}건 · ${after.rows[0].lo?.toISOString().slice(0, 19)} ~ ${after.rows[0].hi?.toISOString().slice(0, 19)} UTC`);

lite.close();
await pool.end();
