import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { r2Store, projectArchiveStore, readManifest, readRows } from '../src/archive.ts';

// Read verified TOP100 shards only. No database connection or archive writes.
const config = JSON.parse(await readFile('config/history-sources.json', 'utf8'));
const remote = r2Store();
const root = { get: remote.get, put: async () => { throw new Error('Read-only inspection'); } };
const sources = [
  { name: 'A', store: root, id: config.frozen.manifest },
  ...config.live.map((s: any) => ({ name: s.schema, store: projectArchiveStore(root, s.project), id: undefined })),
];
const all = new Map<string, any>();
const coverage = [];
for (const source of sources) {
  const result = await readManifest(source.store, source.id);
  if (!result) throw new Error(`Missing manifest: ${source.name}`);
  const shards = result.manifest.shards.filter(s => s.table === 'market_rankings');
  const bytes = shards.reduce((sum, s) => sum + s.bytes, 0);
  if (bytes > 5_000_000) throw new Error('Ranking read exceeds 5 MB safety bound');
  let rows = 0;
  const captures = new Set<string>();
  for (const shard of shards) {
    for (const archived of await readRows(source.store, shard)) {
      const r = JSON.parse(archived.row);
      const at = new Date(r.captured_at).toISOString();
      all.set(`${at}|${r.item_id}`, {
        capturedAt: at, id: r.item_id, name: r.item_name, rank: Number(r.rank),
        value: Number(r.turnover_24h), basis: r.basis,
      });
      rows++; captures.add(at);
    }
  }
  const dates = [...captures].sort();
  coverage.push({ source: source.name, archivedAt: result.manifest.createdAt,
    shards: shards.length, bytes, rows, captures: dates.length, first: dates[0], last: dates.at(-1) });
}
const rows = [...all.values()].sort((a,b) => a.capturedAt.localeCompare(b.capturedAt) || a.rank-b.rank);
const grouped = new Map<string, any[]>();
for (const row of rows) grouped.set(row.capturedAt, [...(grouped.get(row.capturedAt) ?? []), row]);
const totals = [...grouped].map(([at, rs]) => ({ at, items: rs.length,
  total: rs.reduce((s,r)=>s+r.value,0),
  estimated: rs.filter(r=>r.basis==='estimated').reduce((s,r)=>s+r.value,0),
  estimatedItems: rs.filter(r=>r.basis==='estimated').length }));
await mkdir('data/top100-r2-inspection', {recursive:true});
await writeFile('data/top100-r2-inspection/rows.json', JSON.stringify(rows));
await writeFile('data/top100-r2-inspection/summary.json', JSON.stringify({coverage,totals},null,2));
console.log(JSON.stringify({coverage, totalCaptures: totals.length, totalRows: rows.length,
  first: totals[0], last: totals.at(-1)},null,2));
