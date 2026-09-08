// 전역·개별 수집과 시간봉 집계를 따로 확인하고 지연 시 실패 코드로 끝낸다.

import { query, pool } from '../src/db.ts';
import { candleFreshness } from '../src/candle-check.ts';

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
    console.log(`전역 마지막 성공 수집 ${detail}`);
  }
}

const stale = (await query<{ item_name: string }>(`
  SELECT i.item_name FROM items i
  WHERE i.tracked AND COALESCE((
    SELECT MAX(r.finished_at) FROM collection_runs r
    WHERE r.item_id = i.item_id AND r.error IS NULL AND r.finished_at IS NOT NULL
  ), '-infinity'::timestamptz) < now() - make_interval(secs => i.poll_interval_sec * 5)
  ORDER BY i.item_name`)).rows;
if (stale.length) {
  console.error(`⚠ 개별 수집 지연 ${stale.length}종: ${stale.map((i) => i.item_name).join(', ')}`);
  unhealthy = true;
}
const aggregate = (await query<{ refreshed_at: Date | null }>(
  'SELECT refreshed_at FROM candle_pipeline_state WHERE singleton')).rows[0];
const freshness = candleFreshness(aggregate?.refreshed_at ?? null);
if (freshness.stale) {
  console.error(`⚠ 시간봉 집계 지연: ${freshness.ageMinutes?.toFixed(1) ?? '기록 없음'}분 (기준 ${freshness.maxAgeMinutes}분)`);
  unhealthy = true;
} else {
  console.log(`시간봉 마지막 집계 ${freshness.ageMinutes!.toFixed(1)}분 전`);
}
await pool.end();
if (unhealthy) process.exitCode = 1;
