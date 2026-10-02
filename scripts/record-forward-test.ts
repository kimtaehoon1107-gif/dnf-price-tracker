// 전향 검증 FT1 발행·실측 기록. 사이트 빌드의 통합 분석 DB를 읽고 결과는 전역 상태 담당 DB에만 쓴다.
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { checkCandles } from '../src/candle-check.ts';
import { recordForwardTest } from '../src/forward-test-db.ts';

if (!process.env.BUILD_DATABASE_URL) {
  // 짧은 운영 이력만으로 발행하면 학습이 모자란 예측을 정상 발행처럼 남기게 된다.
  console.error('전향 검증 기록: 통합 분석 DB(BUILD_DATABASE_URL)가 필요합니다.');
  process.exit(1);
}
const writer = await pool.connect();
let reader: Awaited<ReturnType<typeof pool.connect>> | undefined;
let inputPool: Awaited<ReturnType<typeof import('../src/build-db.ts').buildPool>> | undefined;
let locked = false;
try {
  await writer.query('SELECT pg_advisory_lock(20261002, 1)');
  locked = true;
  await writer.query(readFileSync(new URL('../sql/forward-test.sql', import.meta.url), 'utf8'));
  const { buildPool, setBuildClock } = await import('../src/build-db.ts');
  inputPool = await buildPool(); reader = await inputPool.connect();
  await setBuildClock(reader);
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const quality = await checkCandles(reader);
  if (quality.stale || quality.mismatches) throw new Error('집계 상태 불량');
  await writer.query('BEGIN');
  const result = await recordForwardTest(writer, reader, quality);
  await writer.query('COMMIT');
  console.log(`전향 검증 기록: 신규 발행 ${result.issued} · 입력 부족 기록 ${result.skipped} · 실측 확정 ${result.settled}${result.idle ? ' · 시작 전' : ''}`);
} catch (error) {
  await writer.query('ROLLBACK').catch(() => {});
  console.error('전향 검증 기록 실패:', (error as { code?: string }).code ?? (error as Error).name);
  process.exitCode = 1;
} finally {
  if (reader) { await reader.query('ROLLBACK').catch(() => {}); reader.release(); }
  if (inputPool) await inputPool.end();
  let destroy = false;
  if (locked) {
    try { destroy = !(await writer.query('SELECT pg_advisory_unlock(20261002, 1) AS ok')).rows[0].ok; }
    catch { destroy = true; }
  }
  writer.release(destroy);
  await pool.end();
}
