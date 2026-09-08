// 승인된 파이프라인 수정만 적용한다. 수집 시드·외부 요청·원본 삭제는 실행하지 않는다.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { checkCandles } from '../src/candle-check.ts';

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('SELECT pg_advisory_xact_lock(73190421)');
  await client.query('LOCK TABLE trades IN SHARE ROW EXCLUSIVE MODE');
  const backup = {
    at: new Date().toISOString(),
    candles: (await client.query('SELECT * FROM candles_1h')).rows,
    functions: (await client.query(`SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
      WHERE oid IN ('refresh_candles_1h(timestamptz)'::regprocedure,'check_collection_health()'::regprocedure)`)).rows,
    jobs: (await client.query(`SELECT jobid,jobname,command FROM cron.job
      WHERE jobname IN ('dnf-candles-refresh','dnf-trades-prune')`)).rows,
  };
  mkdirSync('data', { recursive: true });
  const path = `data/pipeline-backup-${backup.at.replace(/[:.]/g, '-')}.json`;
  writeFileSync(path, JSON.stringify(backup));
  const schema = readFileSync('sql/schema.postgres.sql', 'utf8');
  await client.query(schema.split('-- BEGIN CANDLE PIPELINE')[1].split('-- END CANDLE PIPELINE')[0]);
  await client.query('ALTER TABLE listing_deltas ADD COLUMN IF NOT EXISTS invalidated_at timestamptz');
  const invalidated = await client.query(`UPDATE listing_deltas d SET invalidated_at=now()
    FROM listings l WHERE l.auction_no=d.auction_no AND d.reason='vanished_before_expiry'
      AND d.invalidated_at IS NULL AND l.last_seen_at>d.observed_at`);
  const watchdog = readFileSync('sql/watchdog.sql', 'utf8').split("SELECT cron.unschedule('dnf-collect-watchdog')")[0];
  await client.query(watchdog);
  for (const [name, command] of [
    ['dnf-candles-refresh', 'SELECT refresh_candles_1h();'],
    ['dnf-trades-prune', 'SELECT prune_aggregated_trades();'],
  ]) {
    const job = backup.jobs.find((j) => j.jobname === name);
    if (!job) throw new Error(`기존 cron이 없습니다: ${name}`);
    await client.query('SELECT cron.alter_job($1, command := $2)', [job.jobid, command]);
  }
  await client.query('SELECT refresh_candles_1h()');
  const quality = await checkCandles(client);
  if (quality.mismatches) throw new Error(`복구 후에도 불일치 ${quality.mismatches}봉`);
  await client.query('COMMIT');
  console.log(JSON.stringify({ backup: path, invalidated: invalidated.rowCount, quality }));
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
