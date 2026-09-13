import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pool } from '../src/db.ts';

// 비밀번호는 사용자가 로컬 화면에 직접 입력한다. 로그·파일·명령 인수로 남기지 않는다.
const token=randomBytes(32).toString('hex');
let expectedOrigin='', saving=false, complete=false;
const page=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>게시판 관리자 비밀번호 설정</title><style>body{font:16px/1.7 system-ui;background:#f9fafb;color:#191f28;max-width:480px;margin:60px auto;padding:24px}form{background:white;padding:28px;border-radius:16px}h1{font-size:24px}label,input{display:block;width:100%;box-sizing:border-box}input{font:inherit;padding:10px;margin:6px 0 20px;border:1px solid #ddd;border-radius:8px}button{font:inherit;background:#3182f6;color:white;border:0;border-radius:8px;padding:10px 20px}small{color:#666}#result{white-space:pre-line}</style>
<h1>관리자 비밀번호 설정</h1><p>던파 시세 추적기 피드백 게시판의 운영자 비밀번호입니다. 기존 비밀번호가 있으면 교체됩니다.</p>
<form><label>새 관리자 비밀번호<input name="password" type="password" minlength="12" maxlength="72" required autocomplete="new-password"></label>
<label>비밀번호 확인<input name="confirm" type="password" minlength="12" maxlength="72" required autocomplete="new-password"></label>
<small>12자 이상. 이메일 복구가 없으므로 안전한 곳에 보관해 주세요. 입력값은 이 컴퓨터에서 해시 처리 요청에만 사용됩니다.</small><p><button>비밀번호 설정</button></p><p id="result" role="status"></p></form><script src="/setup.js"></script></html>`;
const js=`const form=document.querySelector('form');form.onsubmit=async e=>{e.preventDefault();const output=document.getElementById('result'),button=form.querySelector('button');if(form.password.value!==form.confirm.value){output.textContent='비밀번호가 서로 다릅니다.';return;}button.disabled=true;try{const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',password:form.password.value})});const data=await r.json();output.textContent=data.message;if(r.ok){form.reset();button.remove();}}catch{output.textContent='설정 결과를 확인하지 못했습니다. 터미널에서 완료 메시지를 확인해 주세요.';}finally{button.disabled=false;}};`;
const server=createServer(async(req,res)=>{
  const reply=(code:number,body:string,type='application/json')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'"});res.end(body);};
  if(req.headers.host!==expectedOrigin.replace('http://','')) return reply(403,'{}');
  if(req.method==='GET' && req.url==='/') return reply(200,page,'text/html; charset=utf-8');
  if(req.method==='GET' && req.url==='/setup.js') return reply(200,js,'text/javascript; charset=utf-8');
  if(req.method!=='POST' || req.url!=='/setup' || req.headers.origin!==expectedOrigin || req.headers['content-type']!=='application/json' || saving || complete) return reply(403,'{}');
  let body='';
  try {
    for await(const chunk of req) {body+=chunk; if(Buffer.byteLength(body)>2048) return reply(413,JSON.stringify({message:'입력값이 너무 깁니다.'}));}
    const data=JSON.parse(body);
    if(data.token!==token || typeof data.password!=='string' || [...data.password].length<12 || Buffer.byteLength(data.password)>72 || /\p{Cc}/u.test(data.password)) return reply(422,JSON.stringify({message:'비밀번호는 12자 이상, UTF-8 기준 72바이트 이하로 입력해 주세요.'}));
    saving=true;
    await pool.query(`INSERT INTO feedback_private.admin(singleton,password_hash) VALUES(true,extensions.crypt($1,extensions.gen_salt('bf',12)))
      ON CONFLICT(singleton) DO UPDATE SET password_hash=excluded.password_hash`,[data.password]);
    complete=true;
    reply(200,JSON.stringify({message:'관리자 비밀번호 설정을 완료했습니다.\n게시판의 관리자 버튼에서 로그인할 수 있습니다. 이 창은 닫아도 됩니다.'}));
    console.log('관리자 비밀번호 설정 완료. 입력값은 기록하지 않았습니다.');
    clearTimeout(expiry); server.close(); await pool.end();
  } catch {saving=false; reply(500,JSON.stringify({message:'설정에 실패했습니다. 게시판 DB 설치와 연결을 확인해 주세요.'}));}
});
server.listen(0,'127.0.0.1',()=>{expectedOrigin=`http://127.0.0.1:${(server.address() as any).port}`;console.log(`비밀번호 설정 화면: ${expectedOrigin}\n10분 동안만 열립니다. 비밀번호는 화면에 직접 입력하세요.`);});
const expiry=setTimeout(()=>{server.close(); pool.end(); console.log('설정 화면이 만료됐습니다. 다시 실행해 주세요.');},10*60*1000);
process.on('SIGINT',()=>{clearTimeout(expiry);server.close();pool.end();});
