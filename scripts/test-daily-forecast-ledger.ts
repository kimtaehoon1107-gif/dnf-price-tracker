import assert from 'node:assert/strict';
import {VERSION,MODELS,makeInput,validateIssue,settle,evaluate,checkSnapshot,shift} from '../src/daily-forecast-ledger.ts';
import {journal} from './record-daily-vwap.ts';

const origin='2026-10-06',now='2026-10-06T06:00:00Z';
const daily=Array.from({length:30},(_,i)=>({d:shift(origin,i-30),vwap:100+i,n:10}));
const input=makeInput([{id:'a',name:'a',daily:[...daily,{d:origin,vwap:999999,n:100}]}],origin);
assert.equal(input.latest[0].train.length,30);
assert.equal(input.latest[0].train.at(-1).vwap,129);
const withoutFuture=makeInput([{id:'a',name:'a',daily}],origin);
assert.deepEqual(input,withoutFuture,'당일 가격 혼입');
assert.equal(makeInput([{id:'a',name:'a',daily:daily.filter(p=>p.d!==shift(origin,-2))}],origin).latest.length,0);
const values=Object.fromEntries(MODELS.map(m=>[m,110]));
const issue={version:VERSION,origin,issuedAt:now,items:[{id:'a',name:'a',predictions:[1,3,7].map(h=>({h,d:shift(origin,h),values}))}]};
validateIssue(issue,now);
assert.throws(()=>validateIssue(issue,'2026-10-07T06:00:00Z'));
assert.throws(()=>validateIssue({...issue,items:[{...issue.items[0],predictions:[{h:1,d:origin,values}]}]},now));
assert.throws(()=>settle('2026-10-07',[],['a'],'2026-10-08T06:00:00Z'));
const actual=settle('2026-10-07',[{id:'a',name:'a',daily:[{d:'2026-10-07',vwap:100,n:5}]}],['a'],'2026-10-09T06:00:00Z');
const scores=evaluate([issue],[actual]);
assert.equal(scores.rows.length,1);assert.equal(scores.pending.length,2);
assert(Math.abs(scores.scores[0].mape!-10)<1e-9);
const thin=settle('2026-10-07',[{id:'a',name:'a',daily:[{d:'2026-10-07',vwap:100,n:4}]}],['a'],'2026-10-09T06:00:00Z');
assert.equal(evaluate([issue],[thin]).rows.length,0);
assert.equal(evaluate([issue],[thin]).excluded.length,1);
assert.throws(()=>checkSnapshot({priceAsOf:'2026-10-05T00:00:00Z',quality:{}},now));

// 실제 전송할 명령의 조건과 충돌 처리를 검사한다. 기존 값을 대체하지 않는다.
let saved:string|undefined;
const store=journal({async send(command:any){
  const p=command.input;
  if(command.constructor.name==='PutObjectCommand') {
    assert.equal(p.IfNoneMatch,'*');
    if(saved)throw {$metadata:{httpStatusCode:412}};
    saved=p.Body;return {};
  }
  return {Body:{transformToString:async()=>saved}};
}},'test');
assert(await store.putOnce('issues/2026-10-06.json',issue));
assert.equal(await store.putOnce('issues/2026-10-06.json',{changed:true}),false);
assert.deepEqual(await store.get('issues/2026-10-06.json'),issue);
console.log('개별 예측: 시점 누출·날짜 경계·실측 대기·동일 사례 평가·최초 저장 보호 통과');
