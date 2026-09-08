import assert from 'node:assert/strict';
import { pool } from '../src/db.ts';
import { checkCandles } from '../src/candle-check.ts';

const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result = await checkCandles(client);
  console.log(JSON.stringify(result));
  assert.equal(result.mismatches, 0, '시간봉과 원본이 다릅니다. 검사는 데이터를 수정하지 않습니다.');
  console.log('시간봉 읽기 전용 대조 통과');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
