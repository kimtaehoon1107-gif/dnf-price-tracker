import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { checkCandles } from '../src/candle-check.ts';
import { loadResearch } from '../src/research-data.ts';
import { RESEARCH_VERSION, issueForecast, kstDay, shiftDay, type Issue } from '../src/research.ts';

const client = await pool.connect();
let locked = false;
try {
  // 잠금을 기다린 뒤 스냅샷을 열어 먼저 끝난 발행의 결과를 볼 수 있게 한다.
  await client.query('SELECT pg_advisory_lock(20260916, 1)');
  locked = true;
  await client.query(readFileSync(new URL('../sql/research.sql', import.meta.url), 'utf8'));
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const quality = await checkCandles(client);
  if (quality.stale || quality.mismatches) throw new Error('집계 상태 불량');
  const origin = kstDay(quality.checkedAt);
  const data = await loadResearch(client, quality.checkedAt, quality.through);
  const batches = (await client.query<{ origin: string; issues: Issue[] }>(
    'SELECT origin,issues FROM research_forecast_batches WHERE version=$1 ORDER BY origin', [RESEARCH_VERSION])).rows;
  // 전날 시간봉 집계가 끝난 KST 02시 이후 첫 실행에만 그날의 예측을 고정한다.
  const hour = new Date(Date.parse(quality.checkedAt) + 9 * 3600000).getUTCHours();
  let issued = 0;
  if (hour >= 2 && data.before === origin && !batches.some((b) => b.origin === origin)) {
    const issues = data.series.map((s) => issueForecast(s.id, s.daily, origin));
    issued = (await client.query(`INSERT INTO research_forecast_batches(version,origin,issued_at,data_as_of,issues)
      VALUES($1,$2,clock_timestamp(),$3,$4) ON CONFLICT DO NOTHING`,
    [RESEARCH_VERSION, origin, quality.checkedAt, JSON.stringify(issues)])).rowCount ?? 0;
  }
  // 대상일 종료 후 24시간을 더 기다린 첫 정상 집계에서 실측을 고정한다.
  // 미관측은 null로 확정하며, 사후 백필로 점수를 유리하게 다시 쓰지 않는다.
  const settled = new Set((await client.query<{ target: string }>(
    'SELECT target FROM research_actuals WHERE version=$1', [RESEARCH_VERSION])).rows.map((r) => r.target));
  const targets = [...new Set(batches.flatMap((b) => b.issues.flatMap((i) =>
    i.predictions.filter((p) => p.h === 1 || p.h === 7).map((p) => p.d))))]
    .filter((d) => d <= shiftDay(origin, -2) && d < data.before && !settled.has(d));
  for (const target of targets) {
    const values = Object.fromEntries(data.series.map((s) => [s.id, s.daily.find((p) => p.d === target)?.value ?? null]));
    await client.query(`INSERT INTO research_actuals(version,target,settled_at,values)
      VALUES($1,$2,clock_timestamp(),$3) ON CONFLICT DO NOTHING`, [RESEARCH_VERSION, target, JSON.stringify(values)]);
  }
  await client.query('COMMIT');
  console.log(`사전 예측 기록: ${origin} 신규 ${issued}일 · 실측 확정 ${targets.length}일`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('사전 예측 기록 실패:', (error as { code?: string }).code ?? (error as Error).name);
  process.exitCode = 1;
} finally {
  let destroy = false;
  if (locked) {
    try { destroy = !(await client.query('SELECT pg_advisory_unlock(20260916, 1) AS ok')).rows[0].ok; }
    catch { destroy = true; }
  }
  client.release(destroy);
  await pool.end();
}
