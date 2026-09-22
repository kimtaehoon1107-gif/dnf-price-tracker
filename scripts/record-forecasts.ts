import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { checkCandles } from '../src/candle-check.ts';
import { loadResearch } from '../src/research-data.ts';
import { LEGACY_RESEARCH_VERSION, RESEARCH_VERSION, issueForecast, kstDay, shiftDay, type Issue } from '../src/research.ts';

const client = await pool.connect();
let reader = client;
let inputPool: typeof pool | undefined;
let locked = false;
try {
  // 잠금을 기다린 뒤 스냅샷을 열어 먼저 끝난 발행의 결과를 볼 수 있게 한다.
  await client.query('SELECT pg_advisory_lock(20260916, 1)');
  locked = true;
  await client.query(readFileSync(new URL('../sql/research.sql', import.meta.url), 'utf8'));
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  if (process.env?.BUILD_DATABASE_URL) {
    const { buildPool, setBuildClock } = await import('../src/build-db.ts');
    inputPool = await buildPool(); reader = await inputPool.connect();
    await setBuildClock(reader);
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  const quality = await checkCandles(reader);
  if (quality.stale || quality.mismatches) throw new Error('집계 상태 불량');
  const origin = kstDay(quality.checkedAt);
  const before = [origin, kstDay(quality.through)].sort()[0];
  // 발행·실측 확정이 없는 시간에는 과거 연구 입력을 내려받을 필요가 없다.
  const loaded = new Map<string, Awaited<ReturnType<typeof loadResearch>>>();
  async function getData(version = RESEARCH_VERSION) {
    if (!loaded.has(version)) loaded.set(version, await loadResearch(reader, quality.checkedAt, quality.through, version));
    return loaded.get(version)!;
  }
  const batches = (await client.query<{ origin: string; issues: Issue[] }>(
    'SELECT origin,issues FROM research_forecast_batches WHERE version=$1 ORDER BY origin', [RESEARCH_VERSION])).rows;
  // 전날 시간봉 집계가 끝난 KST 02시 이후 첫 실행에만 그날의 예측을 고정한다.
  const hour = new Date(Date.parse(quality.checkedAt) + 9 * 3600000).getUTCHours();
  let issued = 0;
  if (hour >= 2 && before === origin && !batches.some((b) => b.origin === origin)) {
    const data = await getData();
    const issues = data.series.map((s) => issueForecast(s.id, s.daily, origin));
    issued = (await client.query(`INSERT INTO research_forecast_batches(version,origin,issued_at,data_as_of,issues)
      VALUES($1,$2,clock_timestamp(),$3,$4) ON CONFLICT DO NOTHING`,
    [RESEARCH_VERSION, origin, quality.checkedAt, JSON.stringify(issues)])).rowCount ?? 0;
  }
  // 대상일 종료 후 24시간을 더 기다린 첫 정상 집계에서 실측을 고정한다.
  // 미관측은 null로 확정하며, 사후 백필로 점수를 유리하게 다시 쓰지 않는다.
  let settledCount = 0;
  for (const version of [LEGACY_RESEARCH_VERSION, RESEARCH_VERSION]) {
    const versionBatches = version === RESEARCH_VERSION ? batches :
      (await client.query<{ origin: string; issues: Issue[] }>(
        'SELECT origin,issues FROM research_forecast_batches WHERE version=$1 ORDER BY origin', [version])).rows;
    const settled = new Set((await client.query<{ target: string }>(
      'SELECT target FROM research_actuals WHERE version=$1', [version])).rows.map((r) => r.target));
    const targets = [...new Set(versionBatches.flatMap((b) => b.issues.flatMap((i) =>
      i.predictions.filter((p) => p.h === 1 || p.h === 7).map((p) => p.d))))]
      .filter((d) => d <= shiftDay(origin, -2) && d < before && !settled.has(d));
    if (!targets.length) continue;
    // v1의 남은 예측도 원래 집계로 끝까지 평가하되 새 예측은 v2에만 발행한다.
    const actualData = await getData(version);
    for (const target of targets) {
      const values = Object.fromEntries(actualData.series.map((s) => [s.id, s.daily.find((p) => p.d === target)?.value ?? null]));
      await client.query(`INSERT INTO research_actuals(version,target,settled_at,values)
        VALUES($1,$2,clock_timestamp(),$3) ON CONFLICT DO NOTHING`, [version, target, JSON.stringify(values)]);
      settledCount++;
    }
  }
  await client.query('COMMIT');
  console.log(`사전 예측 기록: ${origin} 신규 ${issued}일 · 실측 확정 ${settledCount}일`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('사전 예측 기록 실패:', (error as { code?: string }).code ?? (error as Error).name);
  process.exitCode = 1;
} finally {
  if (inputPool) { await reader.query('ROLLBACK'); reader.release(); await inputPool.end(); }
  let destroy = false;
  if (locked) {
    try { destroy = !(await client.query('SELECT pg_advisory_unlock(20260916, 1) AS ok')).rows[0].ok; }
    catch { destroy = true; }
  }
  client.release(destroy);
  await pool.end();
}
