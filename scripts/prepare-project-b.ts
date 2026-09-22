// 빈 B에 스키마와 아이템 설정만 준비한다. 수집 전환·예약 등록·과거 이력 복사는 하지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const apply = process.argv.slice(2);
assert(apply.length === 0 || (apply.length === 1 && apply[0] === '--apply'), '인자는 --apply만 허용합니다');
const sourceUrl = new URL(process.env.DATABASE_URL!);
const targetUrl = new URL(process.env.DATABASE_URL_B!);
assert.equal(sourceUrl.username, 'postgres.ypmnadqnmadrburkrcka', '기존 A 연결을 확인하세요');
assert.equal(targetUrl.username, 'postgres.ejtjwtlehkzuutqgzevu', '확인한 B 프로젝트만 준비합니다');
assert.equal(targetUrl.hostname, 'aws-0-ap-northeast-2.pooler.supabase.com');
assert.equal(targetUrl.port, '5432');
assert.equal(targetUrl.pathname, '/postgres');
assert.equal(targetUrl.search, '', '연결 보안 옵션을 URL로 덮어쓰지 않습니다');
const ssl = { ca: readFileSync(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8'), rejectUnauthorized: true };
const source = new pg.Client({ connectionString: sourceUrl.toString(), ssl, connectionTimeoutMillis: 15000 });
const target = new pg.Client({ connectionString: targetUrl.toString(), ssl, connectionTimeoutMillis: 15000 });
const fingerprint = (rows: { row: string }[]) => createHash('sha256').update(rows.map(r => r.row).join('\n')).digest('hex');
const itemRows = 'SELECT to_jsonb(i)::text AS row FROM public.items i ORDER BY item_id';
const columns = `SELECT column_name, udt_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='items' ORDER BY column_name`;

try {
  await source.connect();
  await target.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await source.query("SET LOCAL statement_timeout='30s'; SET LOCAL timezone='UTC'");
  await target.query('BEGIN');
  await target.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET LOCAL timezone='UTC'");
  await target.query('SELECT pg_advisory_xact_lock(731905, 20260922)');
  const existing = await target.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')`);
  assert.equal(existing.rowCount, 0, 'B가 비어 있지 않습니다. 재실행으로 덮어쓰지 않습니다');
  const cron = await target.query("SELECT to_regclass('cron.job') IS NOT NULL AS installed");
  if (cron.rows[0].installed) {
    const jobs = await target.query('SELECT count(*)::int AS n FROM cron.job WHERE active');
    assert.equal(jobs.rows[0].n, 0, 'B의 활성 예약 작업을 먼저 확인하세요');
  }
  const size = (await source.query(`SELECT count(*)::int AS items, count(*) FILTER (WHERE tracked)::int AS tracked,
    COALESCE(sum(octet_length(to_jsonb(i)::text)),0)::int AS bytes FROM public.items i`)).rows[0];
  assert(size.items > 0 && size.bytes < 1_000_000, '설정 복사량이 예상 범위를 벗어났습니다');
  if (!apply.length) {
    console.log(JSON.stringify({ mode: 'inspect', targetEmpty: true, ...size }));
  } else {
    for (const file of ['schema.postgres.sql', 'research.sql', 'legendary-scans.sql']) {
      await target.query(readFileSync(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
    }
    assert.deepEqual((await target.query(columns)).rows, (await source.query(columns)).rows, '아이템 스키마가 다릅니다');
    const rows = (await source.query(itemRows)).rows;
    await target.query('INSERT INTO public.items SELECT * FROM jsonb_populate_recordset(NULL::public.items,$1::jsonb)',
      ['[' + rows.map(r => r.row).join(',') + ']']);
    // 사이트는 정적 파일을 제공한다. 새 테이블/함수를 익명 Data API에 노출할 필요가 없다.
    const tables = (await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
    for (const { tablename } of tables) {
      assert(/^[a-z_][a-z_0-9]*$/.test(tablename));
      await target.query(`ALTER TABLE public.${tablename} ENABLE ROW LEVEL SECURITY`);
    }
    await target.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
      REVOKE EXECUTE ON FUNCTION public.refresh_candles_1h(timestamptz), public.prune_aggregated_trades()
        FROM PUBLIC, anon, authenticated`);
    const copied = (await target.query(itemRows)).rows;
    assert.equal(copied.length, rows.length);
    assert.equal(fingerprint(copied), fingerprint(rows), '설정 대조 실패');
    const empty = (await target.query(`SELECT
      (SELECT count(*)::int FROM trades) AS trades,
      (SELECT count(*)::int FROM collection_runs) AS runs,
      (SELECT refreshed_at IS NULL AND raw_max_id IS NULL FROM candle_pipeline_state WHERE singleton) AS unstarted`)).rows[0];
    assert.deepEqual(empty, { trades: 0, runs: 0, unstarted: true });
    await source.query('ROLLBACK');
    await target.query('COMMIT');
    console.log(JSON.stringify({ mode: 'prepared', ...size, tables: tables.length, itemsHash: fingerprint(rows), collectionStarted: false }));
  }
} catch (error) {
  // 연결 문자열과 서버 오류 detail에는 민감한 값이 포함될 수 있다.
  console.error(error instanceof assert.AssertionError ? error.message : `B 준비 실패 (${(error as { code?: string }).code ?? 'connection/query'})`);
  process.exitCode = 1;
} finally {
  await source.query('ROLLBACK').catch(() => {});
  await target.query('ROLLBACK').catch(() => {});
  await source.end().catch(() => {});
  await target.end().catch(() => {});
}
