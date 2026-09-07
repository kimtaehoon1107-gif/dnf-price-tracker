// 수집기 생존 확인. 마지막 성공 수집이 10분보다 오래됐으면 실패 코드로 끝낸다.

import { query, pool } from '../src/db.ts';

const { rows } = await query<{
  finished_at: Date;
  source: string | null;
  item_name: string | null;
}>(`
  SELECT r.finished_at, r.source, i.item_name
  FROM collection_runs r
  LEFT JOIN items i USING (item_id)
  WHERE r.error IS NULL AND r.finished_at IS NOT NULL
  ORDER BY r.finished_at DESC
  LIMIT 1`);

const last = rows[0];
let unhealthy = false;

if (!last) {
  console.error('⚠ 성공한 수집 기록이 없습니다.');
  unhealthy = true;
} else {
  const ageMinutes = (Date.now() - last.finished_at.getTime()) / 60_000;
  const detail = `${ageMinutes.toFixed(1)}분 전 · ${last.item_name ?? '알 수 없는 아이템'} · ${last.source ?? '출처 미기록'}`;
  if (ageMinutes > 10) {
    console.error(`⚠ 마지막 성공 수집이 10분을 넘었습니다: ${detail}`);
    unhealthy = true;
  } else {
    console.log(`정상 · 마지막 성공 수집 ${detail}`);
  }
}

await pool.end();
if (unhealthy) process.exitCode = 1;
