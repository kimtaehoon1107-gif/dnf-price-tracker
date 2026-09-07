// DATABASE_URL이 제대로 들어갔는지 확인한다.
//
// 연결 문자열은 틀리기 쉽다 — 비밀번호 자리를 안 바꿨거나, 특수문자를
// percent-encode 안 했거나, IPv6인 Direct connection을 골랐거나.
// 오류 메시지가 불친절해서 여기서 사람이 읽을 수 있는 말로 바꿔준다.
//
//   npm run db:check

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('✗ DATABASE_URL이 비어 있습니다.\n');
  console.error('  .env 파일을 열어 DATABASE_URL= 뒤에 Supabase 연결 문자열을 넣으세요.');
  console.error('  Supabase 프로젝트 상단 [Connect] > Session pooler > URI');
  process.exit(1);
}
if (url.includes('[YOUR-PASSWORD]') || url.includes('[YOUR_PASSWORD]')) {
  console.error('✗ 비밀번호 자리를 안 바꾸셨습니다.\n');
  console.error('  [YOUR-PASSWORD] 부분을 프로젝트 만들 때 정한 비밀번호로 바꾸세요.');
  process.exit(1);
}
if (/db\.[a-z0-9]+\.supabase\.co/.test(url)) {
  console.error('⚠ Direct connection 문자열로 보입니다 (db.xxxxx.supabase.co).\n');
  console.error('  이건 IPv6 전용이라 GitHub Actions에서 연결되지 않습니다.');
  console.error('  [Connect] > Session pooler 쪽 URI로 바꾸세요 (…pooler.supabase.com).');
  console.error('  로컬에서만 쓸 거라면 이대로도 동작할 수는 있습니다.\n');
}

const { pool } = await import('../src/db.ts');

try {
  const r = await pool.query<{ v: string; db: string; now: Date }>(
    'SELECT version() AS v, current_database() AS db, now() AS now');
  console.log('✓ 연결 성공');
  console.log(`  DB      ${r.rows[0].db}`);
  console.log(`  서버    ${r.rows[0].v.split(' ').slice(0, 2).join(' ')}`);
  console.log(`  서버시각 ${r.rows[0].now.toISOString()}`);

  const t = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  console.log(`  테이블  ${t.rows[0].n}개` + (t.rows[0].n === 0 ? '  → 다음: npm run init' : ''));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('✗ 연결 실패\n');
  if (/password authentication failed|SASL/i.test(msg)) {
    console.error('  비밀번호가 틀렸습니다. 특수문자가 있다면 percent-encode 하세요.');
    console.error('  @ -> %40   # -> %23   ? -> %3F   / -> %2F   : -> %3A');
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    console.error('  호스트를 찾을 수 없습니다. 연결 문자열의 주소를 다시 확인하세요.');
  } else if (/ENETUNREACH|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    console.error('  연결이 닿지 않습니다. Direct connection(IPv6) 대신');
    console.error('  Session pooler URI를 쓰고 있는지 확인하세요.');
  } else {
    console.error(`  ${msg}`);
  }
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
