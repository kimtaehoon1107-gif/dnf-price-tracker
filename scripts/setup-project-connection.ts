// 새 프로젝트의 기존 비밀번호를 사용자가 직접 입력한다. A의 운영 연결은 바꾸지 않는다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import pg from 'pg';

const [slot, project, host] = process.argv.slice(2);
assert(['B', 'C'].includes(slot) && /^[a-z]{20}$/.test(project), '대상은 B/C와 확인한 프로젝트 ID입니다');
assert(/^aws-\d+-ap-northeast-2\.pooler\.supabase\.com$/.test(host), '서울 Session pooler 주소가 필요합니다');
const key = `DATABASE_URL_${slot}`, token = randomBytes(32).toString('hex');
const ca = await readFile(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8');
const envPath = new URL('../.env', import.meta.url);
const original = await readFile(envPath, 'utf8');
assert(!new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm').test(original), `${key}가 이미 있습니다. 덮어쓰지 않습니다.`);
let origin = '', saving = false, complete = false;
const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>새 DB 연결 설정</title><style>body{font:16px/1.7 system-ui;background:#f7f8fa;color:#192332;max-width:500px;margin:55px auto;padding:24px}form{background:white;padding:26px;border-radius:16px}input{box-sizing:border-box;width:100%;font:inherit;padding:10px;margin:8px 0 20px;border:1px solid #bbc4ce;border-radius:8px}button{font:inherit;background:#2563eb;color:white;border:0;padding:12px 18px;border-radius:8px}small{color:#526173}#result{white-space:pre-line}</style>
<h1>${slot} 프로젝트 연결</h1><p>Supabase에서 방금 정한 <strong>DB 비밀번호</strong>를 입력해 주세요.</p>
<form><label>DB 비밀번호<input type="password" name="password" autocomplete="off" required maxlength="1024"></label>
<small>대상: ${project} · 서울<br>입력값으로 이 프로젝트의 연결을 확인하고, 이 컴퓨터의 Git 제외 파일(.env)에 저장합니다. 기존 A 연결은 바꾸지 않으며 채팅이나 로그에 비밀번호를 출력하지 않습니다.</small>
<p><button>연결 확인 및 로컬 저장</button></p><p id="result" role="status"></p></form><script src="/connect.js"></script></html>`;
const js = `document.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target,b=f.querySelector('button'),r=document.getElementById('result');b.disabled=true;r.textContent='연결 확인 중…';try{const response=await fetch('/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',password:f.password.value})});const data=await response.json();r.textContent=data.message;if(response.ok){f.reset();b.remove();}else b.disabled=false;}catch{r.textContent='연결 결과를 확인하지 못했습니다. Codex에서 상태를 확인해 주세요.';b.disabled=false;}};`;
const server = createServer(async (req, res) => {
  const reply = (status: number, body: string, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    res.end(body);
  };
  if (req.headers.host !== origin.slice(7)) return reply(403, '{}');
  if (req.method === 'GET' && req.url === '/') return reply(200, page, 'text/html; charset=utf-8');
  if (req.method === 'GET' && req.url === '/connect.js') return reply(200, js, 'text/javascript; charset=utf-8');
  if (req.method !== 'POST' || req.url !== '/connect' || req.headers.origin !== origin ||
      req.headers['content-type'] !== 'application/json' || saving || complete) return reply(403, '{}');
  let connection: pg.Client | undefined;
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) return reply(413, '{}'); }
    const input = JSON.parse(body);
    if (input.token !== token || typeof input.password !== 'string' || !input.password.length || input.password.length > 1024)
      return reply(422, JSON.stringify({ message: '입력값을 확인해 주세요.' }));
    saving = true;
    const url = new URL(`postgresql://postgres.${project}@${host}:5432/postgres`);
    url.password = encodeURIComponent(input.password);
    connection = new pg.Client({ connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true },
      connectionTimeoutMillis: 15000, query_timeout: 15000 });
    await connection.connect();
    await connection.query('BEGIN READ ONLY');
    await connection.query('SELECT 1');
    await connection.query('ROLLBACK');
    assert.equal(await readFile(envPath, 'utf8'), original, '설정 파일이 변경됐습니다');
    await appendFile(envPath, `${original.endsWith('\n') ? '' : '\n'}${key}=${url}\n`, 'utf8');
    complete = true;
    reply(200, JSON.stringify({ message: '연결 확인과 저장을 완료했습니다.\nCodex에 “연결 저장 완료”라고 알려 주세요.' }));
    console.log(`${key} 연결 확인 및 로컬 저장 완료. 기존 DATABASE_URL 유지.`);
    clearTimeout(expiry); server.close();
  } catch {
    reply(400, JSON.stringify({ message: '연결 또는 저장에 실패했습니다. DB 비밀번호와 프로젝트 상태를 확인해 주세요. 비밀번호는 기록하지 않았습니다.' }));
  } finally { saving = false; await connection?.end().catch(() => {}); }
});
server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  console.log(`연결 입력 화면: ${origin}\n30분 동안만 열립니다.`);
});
const expiry = setTimeout(() => { server.close(); console.log('입력 화면 만료'); }, 30 * 60_000);
process.on('SIGINT', () => { clearTimeout(expiry); server.close(); });
