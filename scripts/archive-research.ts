import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { capture, combine, hash, localStore, r2Store, projectArchiveStore, readManifest, restore,
  type Manifest, type Store } from '../src/archive.ts';
import { loadResearch } from '../src/research-data.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  from: { type: 'string' }, to: { type: 'string' }, items: { type: 'string' },
  manifest: { type: 'string' }, live: { type: 'boolean', default: false },
} });
const [mode, directory] = positionals;
assert(directory && ['capture', 'publish', 'load'].includes(mode),
  '사용법: archive-research.ts capture|publish|load <새 작업 폴더> [--from ISO --to ISO --items id,id --manifest manifests/hash.json --live]');
const root = resolve(directory), local = localStore(root);
const remoteArchive = () => process.env.ARCHIVE_PROJECT ? projectArchiveStore(r2Store(),process.env.ARCHIVE_PROJECT) : r2Store();
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const save = (file: string, value: unknown) => local.put(file, json(value));
const researchResult = (r: Awaited<ReturnType<typeof loadResearch>>) => ({
  before: r.before, series: r.series, trade: r.trade, legendary: r.legendary,
  byBasis: [...r.byBasis].map(([basis, items]) => [basis, [...items]]),
});

async function source() {
  if (process.env.ARCHIVE_PROJECT) assert.equal(new URL(process.env.DATABASE_URL!).username,`postgres.${process.env.ARCHIVE_PROJECT}`);
  const previous = process.env.R2_ACCOUNT_ID ? await readManifest(remoteArchive()) : null;
  const { pool } = await import('../src/db.ts');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='120s'");
    const manifest = await capture(client, local, previous?.manifest);
    manifest.parent = previous?.id ?? null;
    const research = researchResult(await loadResearch(client, manifest.createdAt, manifest.createdAt));
    await client.query('ROLLBACK');
    await save('source.json', manifest); await save('expected-research.json', research);
    return manifest;
  } finally {
    await client.query('ROLLBACK').catch(() => {}); client.release(); await pool.end();
  }
}

async function target() {
  const connectionString = process.env.ARCHIVE_VERIFY_URL;
  assert(connectionString, 'ARCHIVE_VERIFY_URL 필요');
  const url = new URL(connectionString);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432'); assert.equal(url.pathname, '/archive_verify');
  const client = new pg.Client({ connectionString, ssl: false });
  // 기존 연구 코드와 같은 bigint 해석. 보관/복원 자체는 JSON 원문을 사용한다.
  pg.types.setTypeParser(pg.types.builtins.INT8, v => Number(v));
  await client.connect(); return client;
}

if (mode === 'capture') {
  await mkdir(root); await source();
} else if (mode === 'publish') {
  const current: Manifest = JSON.parse(await readFile(resolve(root, 'source.json'), 'utf8'));
  const remote = remoteArchive(), previous = await readManifest(remote);
  assert.equal(current.parent, previous?.id ?? null, '추출 후 최신 보관본이 변경됐습니다. 다시 추출하세요');
  if (previous) assert(Date.parse(current.createdAt) > Date.parse(previous.manifest.createdAt), '과거 실행으로 최신 보관본을 덮을 수 없습니다');
  const manifest = await combine(previous?.manifest ?? null, current, remote, local, remote);
  manifest.parent = previous?.id ?? null;
  const client = await target();
  let rows: number;
  try {
    rows = await restore(client, manifest, remote);
    const actual = researchResult(await loadResearch(client as any, current.createdAt, current.createdAt));
    const expected = JSON.parse(await readFile(resolve(root, 'expected-research.json'), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, '기존 연구 입력 재현 불일치');
  } finally { await client.end(); }
  const bytes = json(manifest), id = `manifests/${hash(bytes)}.json`;
  await remote.put(id, bytes);
  await readManifest(remote, id);
  const report = { manifest: id, verifiedAt: new Date().toISOString(), sourceAsOf: current.createdAt,
    rows, shards: manifest.shards.length, compressedBytes: manifest.shards.reduce((n, s) => n + s.bytes, 0),
    qualityAvailableFrom: manifest.qualityAvailableFrom, continuity: manifest.continuity,
    researchReproduced: true, productionModified: false };
  await remote.put(`verified/${hash(bytes)}.json`, json(report));
  // 워크플로의 공통 concurrency 잠금 아래에서만 발행한다. 검증 실패 시 latest는 유지된다.
  assert.equal((await readManifest(remote))?.id ?? null, previous?.id ?? null, '다른 발행자가 latest를 갱신했습니다');
  await remote.put('latest.json', json({ manifest: id }));
  assert.equal((await readManifest(remote))?.id, id);
  await save('report.json', report);
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
    `## R2 정기 보관 검증\n\n- ${rows.toLocaleString()}행 실제 복원·내용 대조 통과\n` +
    `- 기존 연구 입력 재현: 통과\n- 품질 기록 시작(UTC): ${manifest.qualityAvailableFrom}\n` +
    `- 연속성: ${manifest.continuity}\n- manifest: ${id}\n- 운영 DB 변경: 없음\n`);
  assert.notEqual(manifest.continuity, 'gap', '6일 초과 보관 공백: 현재 데이터는 보관했지만 과거 품질 기록을 확인해야 합니다');
} else {
  for (const date of [values.from, values.to].filter(Boolean)) {
    assert(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date!) && Number.isFinite(Date.parse(date!)), '기간은 시간대가 있는 ISO 시각으로 입력하세요');
  }
  if (values.from && values.to) assert(Date.parse(values.from) < Date.parse(values.to));
  assert(!values.live || !values.manifest, '고정 보관본 재현과 --live는 함께 사용할 수 없습니다');
  await mkdir(root);
  const remote = remoteArchive(), archived = await readManifest(remote, values.manifest);
  assert(archived, '발행된 보관본이 없습니다');
  assert(await remote.get(`verified/${archived.id.slice(10, -5)}.json`), '검증 성공 기록이 없습니다');
  let manifest = archived.manifest, store: Store = remote;
  if (values.live) {
    const current = await source();
    assert(Date.parse(current.createdAt) >= Date.parse(manifest.createdAt));
    assert.equal(current.parent, archived.id, '조회 중 최신 보관본이 변경됐습니다. 새 폴더에서 다시 실행하세요');
    manifest = await combine(manifest, current, remote, local, local);
    manifest.parent = archived.id;
    store = { get: async key => (await local.get(key)) ?? remote.get(key), put: local.put };
  }
  const selection = { from: values.from, to: values.to, items: values.items?.split(',') };
  if (selection.items) assert(selection.items.every(id => /^[a-f0-9]{32}$/.test(id)), '아이템 ID는 32자리 16진수입니다');
  const client = await target();
  try {
    const rows = await restore(client, manifest, store, selection);
    const research = researchResult(await loadResearch(client as any, manifest.createdAt, values.to ?? manifest.createdAt));
    await save('research.json', research);
    // 이 파일과 manifest를 보관하면 입력 기간/아이템/코드/관측 기준을 다시 확인할 수 있다.
    await save('dataset.json', { archive: archived.id, liveAsOf: values.live ? manifest.createdAt : null,
      continuity: manifest.continuity, qualityAvailableFrom: manifest.qualityAvailableFrom,
      selection, rows, revision: process.env.GITHUB_SHA ?? null, researchSha256: hash(json(research)),
      meaning: 'latest-observed historical reconstruction; not point-in-time knowledge' });
    await save('manifest.json', manifest);
    console.log(`분석용 DB에 ${rows}행 준비. ${root}/research.json, dataset.json`);
    if (manifest.continuity === 'gap') console.warn('보관 공백이 있는 자료입니다. manifest와 품질 기록을 확인하세요.');
  } finally { await client.end(); }
}
