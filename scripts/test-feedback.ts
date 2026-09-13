import assert from 'node:assert/strict';
import { createHandler, validate, rateRules } from '../supabase/functions/feedback/index.ts';

const draft={nickname:'테스트',title:'가격 제보',body:'<script>alert(1)</script>\n본문',category:'bug',password:'test-password-2026'};
assert.deepEqual(validate({action:'create',data:{...draft,admin:true,hidden:true,status:'done',reply:'위조'}}),{action:'create',data:draft});
for(const data of [{...draft,password:'short'},{...draft,password:'가'.repeat(25)},{...draft,title:' '},{...draft,body:'a'.repeat(5001)},{...draft,nickname:'관 리 자'},{...draft,website:'spam'}]) {
  assert.throws(()=>validate({action:'create',data}));
}
assert.throws(()=>validate({action:'moderate',data:{id:1,version:new Date().toISOString(),reply:'위조',status:'done',hidden:false}}));
assert.throws(()=>validate({action:'list',data:{before:-1}}));
assert.equal(validate({action:'detail',data:{id:1,adminPassword:'discarded'}}).data.adminPassword,undefined);
const ownerEdit=rateRules('edit',{id:4},'one'), ownerDelete=rateRules('delete',{id:4},'two');
assert.equal(ownerEdit.at(-1)?.key,ownerDelete.at(-1)?.key,'IP 변경·삭제 경로로 글 비밀번호 시도 제한을 우회할 수 없음');
assert(rateRules('moderate',{},'one').some(r=>r.key==='admin-auth'));
assert(rateRules('detail',{admin:true},'one').some(r=>r.key==='admin-auth'));
const calls: any[]=[];
let allowed=true;
const handler=createHandler(async(name,data)=>{calls.push({name,data}); return name==='feedback_rate_limit'?allowed:{posts:[]};},'fixture-pepper');
const request=(body:any,headers:Record<string,string>={})=>new Request('https://example.test/feedback',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://kimtaehoon1107-gif.github.io',...headers},body:JSON.stringify(body)});
assert.equal((await handler(request({action:'list',data:{}}))).status,200);
assert.equal(calls[0].name,'feedback_rate_limit');
assert.equal(calls[1].name,'feedback_request');
calls.length=0; allowed=false;
assert.equal((await handler(request({action:'create',data:draft}))).status,429);
assert.equal(calls.length,1,'제한 초과 시 비밀번호 해시 계산·글 저장 전에 중단');
assert(!JSON.stringify(calls).includes(draft.password),'횟수 제한에는 비밀번호를 전달하지 않음');
calls.length=0;
assert.equal((await handler(request({action:'list',data:{}},{origin:'https://evil.test'}))).status,403);
assert.equal(calls.length,0);
assert.equal((await handler(request({action:'create',data:{...draft,body:'x'.repeat(25000)}}))).status,413);
const failing=createHandler(async()=>{throw new Error('secret-database-password');},'fixture-pepper');
const failure=await failing(request({action:'list',data:{}}));
assert.equal(failure.status,503);
assert(!(await failure.text()).includes('secret-database-password'));
console.log('게시판 요청 검증·권한 필드·횟수 제한·오류 비공개 테스트 통과');
