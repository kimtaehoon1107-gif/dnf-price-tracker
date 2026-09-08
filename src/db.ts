// Postgres(Supabase) 연결.
//
// 로컬에서 돌리든 GitHub Actions가 돌리든 같은 DB에 쌓는다. 백엔드를 둘로 두면
// 관리 지점이 늘고 무엇보다 데이터가 갈라지기 때문이다.

import pg from 'pg';
import { readFileSync } from 'node:fs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL이 없습니다. .env를 확인하세요 (Supabase > Project Settings > Database > Connection string).');
}

// 골드 금액은 BIGINT로 저장한다. pg는 bigint를 기본적으로 문자열로 주는데,
// 던파 골드는 2^53을 넘지 않으므로 숫자로 받아도 안전하다.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString,
  // Supabase pooler의 사설 루트는 Node 기본 신뢰 저장소에 없다. 공개된
  // Supabase Root 2021 CA를 명시해 인증서와 호스트 이름을 모두 검증한다.
  ssl: {
    ca: readFileSync(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8'),
    rejectUnauthorized: true,
  },
  max: 4,
});

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string, params?: unknown[],
) => pool.query<T>(text, params);

/** 트랜잭션. 실패하면 통째로 롤백한다 — 수집 도중 죽어도 반쪽 데이터가 남지 않는다. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, borrowed?: pg.PoolClient): Promise<T> {
  const client = borrowed ?? await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (!borrowed) client.release();
  }
}

/** API 조회부터 저장까지 같은 아이템을 직렬화한다. 대기자도 연결 하나만 사용한다. */
export async function withItemLock<T>(itemId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false, destroy = false;
  try {
    await client.query('SELECT pg_advisory_lock(731905, hashtext($1))', [itemId]);
    locked = true;
    return await fn(client);
  } finally {
    if (locked) {
      try {
        const result = await client.query('SELECT pg_advisory_unlock(731905, hashtext($1)) AS unlocked', [itemId]);
        destroy = !result.rows[0].unlocked;
      } catch {
        // 잠금 해제를 확인하지 못한 세션을 풀에 돌려주면 다음 수집을 영구 차단할 수 있다.
        destroy = true;
      }
    } else {
      destroy = true;
    }
    client.release(destroy);
  }
}

export const nowIso = () => new Date().toISOString();

/** 정렬된 숫자 배열에서 분위수. 보간 없이 가장 가까운 값을 쓴다(골드는 정수). */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
