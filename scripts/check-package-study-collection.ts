// 현재 수집 담당 B/C만 읽는다. A 연결·과거 전체 복원·운영 변경 없음.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
const config = JSON.parse(readFileSync('config/history-sources.json', 'utf8'));
const members = JSON.parse(readFileSync('config/package-study-members.json', 'utf8'));
const result: any[] = [];
for (const live of config.live) {
  const ids = members.filter((m: any) => config.owners.some((o: any) => o.itemId === m.id && o.source === live.schema && o.to === null)).map((m: any) => m.id);
  if (!ids.length) continue;
  const url = process.env[live.secret];
  assert(url && new URL(url).username === `postgres.${live.project}`);
  const c = new pg.Client({ connectionString: url, ssl: { ca: readFileSync('certs/supabase-prod-ca-2021.crt', 'utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  try {
    await c.connect();
    await c.query('BEGIN READ ONLY');
    await c.query("SET LOCAL statement_timeout='15s'");
    const { rows } = await c.query(`SELECT i.item_id, i.item_name, i.tracked, i.poll_interval_sec,
      max(r.finished_at) FILTER (WHERE r.error IS NULL) AS last_success,
      count(r.id) FILTER (WHERE r.error IS NOT NULL)::int AS failed_24h,
      count(r.id) FILTER (WHERE r.error IS NULL AND r.finished_at IS NOT NULL)::int AS succeeded_24h
      FROM items i LEFT JOIN collection_runs r ON r.item_id=i.item_id AND r.started_at>now()-interval '24 hours'
      WHERE i.item_id=ANY($1::text[]) GROUP BY i.item_id`, [ids]);
    result.push(...rows.map(r => ({ source: live.schema, ...r })));
  } finally { await c.query('ROLLBACK').catch(() => {}); await c.end(); }
}
assert.equal(result.length, 21);
const report = { checkedAt: new Date().toISOString(), items: result };
writeFileSync(process.argv[2] ?? 'data/package-study-collection.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
