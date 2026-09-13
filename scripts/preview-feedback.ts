import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';
import { createHandler } from '../supabase/functions/feedback/index.ts';

// 격리된 트랜잭션의 테스트 게시판. 종료하면 글·비밀번호·스키마 변경을 모두 롤백한다.
const connection=await pool.connect();
const client={query:(sql:string,params?:any[])=>connection.query(sql.replaceAll('feedback_',`feedback_qa_${process.pid}_`),params)};
await client.query('BEGIN');
await client.query("SET LOCAL lock_timeout='3s'");
await client.query(readFileSync('sql/feedback.sql','utf8').replace(/^BEGIN;|^COMMIT;/gm,''));
await client.query("INSERT INTO feedback_private.admin VALUES(true,extensions.crypt($1,extensions.gen_salt('bf',10))) ON CONFLICT(singleton) DO UPDATE SET password_hash=excluded.password_hash",['Feedback-Test-Admin-2026']);
let handler: ReturnType<typeof createHandler>;
let pending=Promise.resolve<any>(undefined);
const rpc=(name:string,data:any)=>{
  const task=pending.then(async()=>{
    await client.query('SAVEPOINT request');
    try {
      const result=name==='feedback_rate_limit'
        ? await client.query('SELECT public.feedback_rate_limit($1) AS result',[JSON.stringify(data.p_rules)])
        : await client.query('SELECT public.feedback_request($1,$2) AS result',[data.p_action,data.p_data]);
      await client.query('RELEASE SAVEPOINT request'); return result.rows[0].result;
    } catch {await client.query('ROLLBACK TO SAVEPOINT request'); throw new Error('테스트 DB 요청 실패');}
  });
  pending=task.catch(()=>{}); return task;
};
const server=createServer(async(req,res)=>{
  if(req.url==='/api/feedback') {
    let body=''; for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>24000){res.writeHead(413);res.end('{}');return;}}
    const headers=new Headers();for(const [name,value] of Object.entries(req.headers)) if(value) headers.set(name,Array.isArray(value)?value.join(','):value);
    const response=await handler(new Request(`http://${req.headers.host}/api/feedback`,{method:req.method,headers,body:req.method==='POST'?body:undefined}));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  const file=(req.url||'/').split('?')[0].slice(1)||'feedback.html';
  if(!['feedback.html','feedback.js','feedback.css','style.css'].includes(file)){res.writeHead(404);res.end();return;}
  let body=readFileSync(`web/${file}`,'utf8');
  if(file==='feedback.js') body=body.replace('https://ypmnadqnmadrburkrcka.supabase.co/functions/v1/feedback','/api/feedback');
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(body);
});
server.listen(0,'127.0.0.1',()=>{const origin=`http://127.0.0.1:${(server.address() as any).port}`;handler=createHandler(rpc,'preview-only-pepper',origin);console.log(`격리 테스트 게시판: ${origin}/feedback.html`);});
async function stop(){server.close();await pending;await client.query('ROLLBACK');connection.release();await pool.end();console.log('테스트 변경 롤백 완료');}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
