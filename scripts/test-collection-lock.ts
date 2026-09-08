import assert from 'node:assert/strict';
import { pool, withItemLock } from '../src/db.ts';

// 운영 아이템과 무관한 키로 실제 PostgreSQL 연결 간 경쟁을 재현한다.
const key = `lock-test-${process.pid}-${Date.now()}`;
let entered!: () => void, release!: () => void;
const ready = new Promise<void>((resolve) => { entered = resolve; });
const hold = new Promise<void>((resolve) => { release = resolve; });
let previous = 100;
const deltas: number[] = [];
const first = withItemLock(key, async () => {
  const before = previous;
  entered();
  await hold;
  deltas.push(before - 80);
  previous = 80;
});
let second: Promise<void> | undefined;
try {
  await ready;
  second = withItemLock(key, async () => {
    deltas.push(previous - 80);
    previous = 80;
  });
  const deadline = Date.now() + 5000;
  let waiting = false;
  while (Date.now() < deadline) {
    waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE locktype='advisory' AND classid=731905::oid
        AND objid=(hashtext($1)::bigint & 4294967295)::oid AND NOT granted) AS waiting`, [key])).rows[0].waiting;
    if (waiting) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(waiting, '두 번째 수집이 실제 DB 잠금에서 대기해야 한다.');
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      withItemLock(key + '-other', async () => {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('다른 아이템까지 차단됨')), 2000); }),
    ]);
  } finally { clearTimeout(timer!); }
  release();
  await Promise.all([first, second]);
  assert.deepEqual(deltas, [20, 0], '같은 감소분을 두 번 집계하면 안 된다.');
  await assert.rejects(withItemLock(key, async () => { throw new Error('fixture failure'); }), /fixture failure/);
  // 예외 뒤에 정상 재수집할 수 있어야 한다.
  await withItemLock(key, async () => {});
  const locks = (await pool.query(`SELECT COUNT(*)::int AS n FROM pg_locks
    WHERE locktype='advisory' AND classid=731905::oid
      AND objid=(hashtext($1)::bigint & 4294967295)::oid`, [key])).rows[0].n;
  assert.equal(locks, 0);
  console.log('동일 아이템 직렬화·다른 아이템 병행·실패 후 잠금 해제 통과 (운영 행 변경 없음)');
} finally {
  release();
  await Promise.allSettled([first, ...(second ? [second] : [])]);
  await pool.end();
}
