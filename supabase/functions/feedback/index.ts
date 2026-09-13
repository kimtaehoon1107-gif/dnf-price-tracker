type Rule = { key: string; seconds: number; limit: number };
type Data = Record<string, unknown>;
type Rpc = (name: string, data: Data) => Promise<any>;
const origin = 'https://kimtaehoon1107-gif.github.io';
const encoder = new TextEncoder();

export function rateRules(action: string, data: Data, actor: string): Rule[] {
  const rules: Rule[] = [{ key: 'all:minute', seconds: 60, limit: 600 }, { key: 'all:day', seconds: 86400, limit: 20000 }];
  if (data.admin === true || action === 'admin-login' || action === 'moderate') {
    rules.push({ key: 'admin-auth', seconds: 60, limit: 20 });
  }
  if (action === 'create') rules.push(
    { key: 'create:day', seconds: 86400, limit: 100 },
    { key: `create:${actor}`, seconds: 600, limit: 3 });
  if (action === 'edit' || action === 'delete') rules.push({ key: `owner:${data.id}`, seconds: 900, limit: 10 });
  return rules;
}

// 허용한 필드만 전달해 숨김·관리자 상태를 일반 작성 요청에 섞지 못하게 한다.
export function validate(input: any): { action: string; data: Data } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('요청 형식이 올바르지 않습니다.');
  const action = input.action;
  if (!['list','detail','create','edit','delete','admin-login','moderate'].includes(action)) throw new Error('지원하지 않는 요청입니다.');
  const d = input.data;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.website) throw new Error('입력 항목을 확인해 주세요.');
  const data: Data = {};
  const text = (key: string, min: number, max: number, trim = true) => {
    if (typeof d[key] !== 'string') throw new Error('입력 항목을 확인해 주세요.');
    const value = trim ? d[key].trim() : d[key];
    if ([...value].length < min || [...value].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('입력 길이 또는 문자를 확인해 주세요.');
    data[key] = value;
  };
  const password = (key: string, min: number) => {
    text(key,min,72,false);
    if (encoder.encode(data[key] as string).length>72) throw new Error('비밀번호는 UTF-8 기준 72바이트 이하여야 합니다.');
  };
  if (['detail','edit','delete','moderate'].includes(action)) {
    if (!Number.isSafeInteger(d.id) || d.id<1) throw new Error('글 번호가 올바르지 않습니다.');
    data.id=d.id;
  }
  if (action==='list' && d.before != null) {
    if (!Number.isSafeInteger(d.before) || d.before<1) throw new Error('페이지 정보가 올바르지 않습니다.');
    data.before=d.before;
  }
  if (['create','edit'].includes(action)) {
    text('nickname',1,20); text('title',1,100); text('body',1,5000);
    if (/^(관리자|운영자|admin)$/i.test((data.nickname as string).replace(/\s/g,''))) throw new Error('다른 닉네임을 사용해 주세요.');
    if (!['bug','idea','general'].includes(d.category)) throw new Error('분류를 선택해 주세요.');
    data.category=d.category;
  }
  if (['create','edit','delete'].includes(action)) password('password',8);
  if (['edit','delete','moderate'].includes(action)) {
    if (typeof d.version!=='string' || !/^\d{4}-\d\d-\d\dT/.test(d.version) || !Number.isFinite(Date.parse(d.version))) throw new Error('글을 다시 열어 주세요.');
    data.version=d.version;
  }
  if ((['list','detail'].includes(action) && d.admin===true) || ['admin-login','moderate'].includes(action)) {
    password('adminPassword',12); data.admin=true;
  }
  if (action==='moderate') {
    text('reply',0,5000);
    if (!['open','reviewing','done','closed'].includes(d.status) || typeof d.hidden!=='boolean') throw new Error('처리 상태를 확인해 주세요.');
    data.status=d.status; data.hidden=d.hidden;
  }
  return { action, data };
}

export function createHandler(rpc: Rpc, pepper: string, allowedOrigin = origin) {
  return async (request: Request): Promise<Response> => {
    const requestOrigin=request.headers.get('origin');
    const headers = { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff', 'Access-Control-Allow-Origin':allowedOrigin,
      'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'content-type', 'Vary':'Origin' };
    const response=(body: Data,status=200)=>new Response(JSON.stringify(body),{status,headers});
    if (requestOrigin && requestOrigin!==allowedOrigin) return response({error:'허용되지 않은 출처입니다.'},403);
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers});
    if (request.method!=='POST') return response({error:'POST 요청만 지원합니다.'},405);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return response({error:'JSON 요청이 필요합니다.'},415);
    let parsed: ReturnType<typeof validate>;
    try {
      const reader=request.body?.getReader();
      if (!reader) return response({error:'입력 항목을 확인해 주세요.'},422);
      const chunks: Uint8Array[]=[]; let size=0;
      while (true) {
        const {done,value}=await reader.read(); if (done) break;
        size+=value.length;
        if (size>24000) { await reader.cancel(); return response({error:'글이 너무 깁니다.'},413); }
        chunks.push(value);
      }
      const bytes=new Uint8Array(size); let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
      parsed=validate(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) { return response({error:error instanceof SyntaxError?'요청 형식이 올바르지 않습니다.':(error as Error).message},422); }
    try {
      // IP는 원문을 저장하지 않는다. 전체·글별 제한도 적용해 IP 변경만으로 우회하지 못하게 한다.
      const ip=(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown').slice(0,200);
      const key=await crypto.subtle.importKey('raw',encoder.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const actor=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(ip))),b=>b.toString(16).padStart(2,'0')).join('');
      if (!await rpc('feedback_rate_limit',{p_rules:rateRules(parsed.action,parsed.data,actor)})) {
        return response({error:'요청이 많습니다. 잠시 후 다시 시도해 주세요.'},429);
      }
      const result=await rpc('feedback_request',{p_action:parsed.action,p_data:parsed.data});
      if (result.error) return response({error:result.error},result.status || 400);
      return response(result);
    } catch {
      // DB 오류 본문이나 요청 본문에는 비밀번호가 포함될 수 있으므로 기록·반환하지 않는다.
      return response({error:'게시판 연결이 지연되고 있습니다. 입력한 내용을 보관하고 잠시 후 다시 시도해 주세요.'},503);
    }
  };
}

declare const Deno: { env: { get: (name: string) => string | undefined }; serve: (handler: (r: Request) => Promise<Response>) => void };
if (typeof Deno!=='undefined') {
  const url=Deno.env.get('SUPABASE_URL')!;
  const secret=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !secret) throw new Error('게시판 서버 설정이 필요합니다.');
  const rpc: Rpc=async (name,data)=>{
    const headers: Record<string,string>={apikey:secret,'Content-Type':'application/json'};
    if (!secret.startsWith('sb_secret_')) headers.Authorization=`Bearer ${secret}`;
    const result=await fetch(`${url}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
    if (!result.ok) throw new Error('게시판 DB 요청 실패');
    return await result.json();
  };
  Deno.serve(createHandler(rpc,secret));
}
