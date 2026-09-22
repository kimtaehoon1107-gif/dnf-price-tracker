// 통합 자료는 Actions의 임시 PostgreSQL에서만 읽는다. 운영 DB 연결은 기존 경로를 유지한다.
import assert from 'node:assert/strict';
import pg from 'pg';

export async function buildPool() {
  if (!process.env.BUILD_DATABASE_URL) return (await import('./db.ts')).pool;
  const url = new URL(process.env.BUILD_DATABASE_URL);
  assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55432');
  assert.equal(url.pathname,'/archive_verify');
  pg.types.setTypeParser(pg.types.builtins.INT8, v => Number(v));
  return new pg.Pool({ connectionString: url.toString(), ssl: false, max: 1 });
}

export async function setBuildClock(client: pg.PoolClient) {
  if (!process.env.BUILD_DATABASE_URL) return;
  const asOf = process.env.BUILD_AS_OF!;
  assert(Number.isFinite(Date.parse(asOf)), '통합 DB의 공통 자료 기준 시각이 필요합니다');
  await client.query("SELECT set_config('dnf.as_of',$1,false)", [asOf]);
  // 임시 DB에 설치한 now()만 사용해 복원·빌드 시간만큼 관측 구간이 밀리지 않게 한다.
  await client.query('SET search_path=public,pg_catalog');
}
