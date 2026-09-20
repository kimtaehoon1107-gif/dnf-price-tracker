// 최초 보관본의 생성과 실제 복원 대조. 운영 DB에는 SELECT만 실행한다.
// 매일 전체를 중복 저장하는 정기 보관기는 별도로 구현한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';

// 피드백 비밀번호·인증 정보·운영 로그는 시세 보관본에 포함하지 않는다.
const TABLES: Record<string, string> = {
  items: 'item_id COLLATE "C"',
  trades: 'id',
  candles_1h: 'item_id COLLATE "C", hour',
  candle_pipeline_state: 'singleton',
  listings: 'auction_no',
  listing_deltas: 'id',
  listing_snapshots: 'id',
  events: 'id',
  legendary_card_floor: 'id',
  legendary_card_scans: 'id',
  market_rankings: 'captured_at, item_id COLLATE "C"',
  research_forecast_batches: 'version COLLATE "C", origin COLLATE "C"',
  research_actuals: 'version COLLATE "C", target COLLATE "C"',
};
type Fingerprint = { rows: number; sha256: string };
type Manifest = {
  format: 1;
  createdAt: string;
  sourceVersion: string;
  revision: string | null;
  file: string;
  bytes: number;
  sha256: string;
  tables: Record<string, Fingerprint>;
};

async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function fingerprints(client: pg.Client | pg.PoolClient) {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await client.query('SET LOCAL extra_float_digits = 3');
  const result: Record<string, Fingerprint> = {};
  for (const [table, order] of Object.entries(TABLES)) {
    const hash = createHash('sha256');
    let rows = 0;
    // PostgreSQL이 직렬화한 문자열 그대로 대조해 bigint·numeric·마이크로초를 보존한다.
    await client.query(`DECLARE archive_rows NO SCROLL CURSOR FOR
      SELECT to_jsonb(t)::text AS value FROM public.${table} t ORDER BY ${order}`);
    while (true) {
      const batch = await client.query<{ value: string }>('FETCH FORWARD 5000 FROM archive_rows');
      if (!batch.rows.length) break;
      for (const row of batch.rows) hash.update(row.value + '\n');
      rows += batch.rows.length;
    }
    await client.query('CLOSE archive_rows');
    result[table] = { rows, sha256: hash.digest('hex') };
    console.log(`${table}: ${rows}행 대조값 계산`);
  }
  return result;
}

async function postgresTool(tool: string, args: string[], databaseUrl: string, directory: string, source: boolean) {
  const url = new URL(databaseUrl);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: source ? 'verify-full' : 'disable',
    PGSSLROOTCERT: '/supabase-ca.crt',
    PGCONNECT_TIMEOUT: '30',
    PGOPTIONS: source ? '-c default_transaction_read_only=on' : '',
  };
  const dockerArgs = ['run', '--rm', '--network', 'host',
    ...Object.keys(env).filter((key) => key.startsWith('PG')).flatMap((key) => ['-e', key]),
    '-v', `${resolve(directory)}:/archive`,
    '-v', `${resolve('certs/supabase-prod-ca-2021.crt')}:/supabase-ca.crt:ro`,
    'postgres:17', tool, ...args];
  await new Promise<void>((accept, reject) => {
    // 비밀번호는 명령 인자나 로그에 남기지 않고 자식 프로세스 환경으로 전달한다.
    const child = spawn('docker', dockerArgs, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) accept();
      else {
        const safe = errors.split(env.PGPASSWORD).join('[REDACTED]');
        reject(new Error(`${tool} 실패 (${code}): ${safe}`));
      }
    });
  });
}

async function createArchive(directory: string) {
  // 기존 보관 파일을 실수로 덮어쓰지 않도록 새 디렉터리만 허용한다.
  await mkdir(directory);
  const { pool } = await import('../src/db.ts');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const info = (await client.query(`SELECT pg_export_snapshot() AS snapshot,
      now() AS at, current_setting('server_version') AS version`)).rows[0];
    const tables = await fingerprints(client);
    // 해시 계산과 pg_dump가 동일한 스냅샷을 읽으므로 수집 중에도 일치해야 한다.
    await postgresTool('pg_dump', ['--format=custom', '--compress=6', '--no-owner', '--no-acl',
      '--lock-wait-timeout=10s', `--snapshot=${info.snapshot}`, '--file=/archive/market.dump',
      ...Object.keys(TABLES).flatMap((table) => ['--table', `public.${table}`])],
    process.env.DATABASE_URL!, directory, true);
    await client.query('ROLLBACK');
    const file = resolve(directory, 'market.dump');
    const manifest: Manifest = {
      format: 1, createdAt: info.at.toISOString(), sourceVersion: info.version,
      revision: process.env.GITHUB_SHA ?? null, file: 'market.dump',
      bytes: (await stat(file)).size, sha256: await fileHash(file), tables,
    };
    await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(`압축 보관본: ${manifest.bytes} bytes, ${Object.keys(tables).length}개 테이블`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

async function verifyArchive(directory: string) {
  const manifest: Manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.file, 'market.dump');
  assert.deepEqual(Object.keys(manifest.tables).sort(), Object.keys(TABLES).sort());
  const file = resolve(directory, manifest.file);
  assert.equal((await stat(file)).size, manifest.bytes, '다운로드 크기 불일치');
  assert.equal(await fileHash(file), manifest.sha256, '다운로드 SHA-256 불일치');
  const databaseUrl = process.env.ARCHIVE_VERIFY_URL!;
  const url = new URL(databaseUrl);
  // 복원 명령이 운영 DB를 향할 수 없도록 Actions의 임시 DB 주소만 허용한다.
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert.equal(url.pathname, '/archive_verify');
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_tables WHERE schemaname='public'");
    assert.equal(existing.rowCount, 0, '빈 검증용 DB에만 복원할 수 있습니다');
    await postgresTool('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
      '--dbname=archive_verify', '/archive/market.dump'], databaseUrl, directory, false);
    await client.query('BEGIN READ ONLY');
    const restored = await fingerprints(client);
    assert.deepEqual(restored, manifest.tables, '복원 행 수 또는 내용 불일치');
    await client.query('ROLLBACK');
    // 행 수가 같아도 값 변경을 잡는지 실제 복원본에서 확인하고 즉시 롤백한다.
    await client.query('BEGIN');
    const changed = await client.query(`UPDATE items SET item_name=item_name || ' 검증'
      WHERE item_id=(SELECT item_id FROM items ORDER BY item_id LIMIT 1)`);
    assert.equal(changed.rowCount, 1);
    const corrupted = await fingerprints(client);
    assert.equal(corrupted.items.rows, restored.items.rows);
    assert.notEqual(corrupted.items.sha256, restored.items.sha256, '내용 훼손 감지 실패');
    await client.query('ROLLBACK');
    const report = {
      verifiedAt: new Date().toISOString(), archiveSha256: manifest.sha256,
      sourceCreatedAt: manifest.createdAt, bytes: manifest.bytes,
      tables: restored, totalRows: Object.values(restored).reduce((n, t) => n + t.rows, 0),
      restoredTo: 'temporary PostgreSQL 17', corruptionDetected: true,
      productionModified: false,
    };
    await writeFile(resolve(directory, 'verified.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`복원 검증 통과: ${Object.keys(restored).length}개 테이블, ${report.totalRows}행`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await writeFile(process.env.GITHUB_STEP_SUMMARY,
        `## R2 최초 보관본 복원 검증 완료\n\n기준 시각: ${report.sourceCreatedAt}\n\n` +
        `- 압축 크기: ${(report.bytes / 1e6).toFixed(2)} MB\n- 테이블: ${Object.keys(restored).length}개\n` +
        `- 대조: ${report.totalRows.toLocaleString()}행 전체 SHA-256 일치\n` +
        '- 같은 행 수의 값 훼손 감지: 통과\n- 운영 DB 변경·삭제: 없음\n');
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

const [mode, directory] = process.argv.slice(2);
assert(directory && ['create', 'verify'].includes(mode),
  '사용법: node scripts/archive-baseline.ts create|verify <directory> (Linux + Docker)');
if (mode === 'create') await createArchive(directory);
else await verifyArchive(directory);
