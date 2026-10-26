import assert from 'node:assert/strict';
import {VERSION,MODELS,makeInput,validateIssue,settle,evaluate,checkSnapshot,shift} from '../src/daily-forecast-ledger.ts';
import {journal} from './record-daily-vwap.ts';
import { FORECAST_PREPROCESSING, checkForecastPreprocessing, dailyWorkComplete, dailySnapshotPending } from '../src/daily-forecast-input.ts';

const midnight = '2026-10-24T15:16:00Z';
const pending = {priceAsOf:'2026-10-24T15:07:00Z',quality:{through:'2026-10-24T14:00:00Z',stale:false,mismatches:0}};
assert(dailySnapshotPending(pending,midnight), 'KST 자정 직후 전날 마지막 완료 시간봉은 대기');
assert.throws(()=>checkSnapshot(pending,midnight), '기존 모델의 검증 규칙 자체는 변경하지 않음');
for(const now of ['2026-10-24T17:00:00Z','2026-10-25T15:16:00Z']) assert(!dailySnapshotPending(pending,now));
for(const quality of [{...pending.quality,stale:true},{...pending.quality,mismatches:1},{...pending.quality,through:'2026-10-23T14:00:00Z'}])
  assert(!dailySnapshotPending({...pending,quality},midnight), '지연·불일치·과거 집계를 정상 대기로 숨기지 않음');
assert(!dailySnapshotPending({...pending,priceAsOf:'2026-10-24T15:17:00Z'},midnight), '미래 자료 차단 유지');
const ready={...pending,quality:{...pending.quality,through:'2026-10-24T15:00:00Z'}};
assert(!dailySnapshotPending(ready,midnight), '당일 완료 시간봉이 있으면 기존 발행·실측 경로로 진행');
checkSnapshot(ready,midnight);

checkForecastPreprocessing({ ...FORECAST_PREPROCESSING, excludedTrades: 100 });
for (const cleaning of [undefined, {}, { ...FORECAST_PREPROCESSING, version: 'different' },
  { ...FORECAST_PREPROCESSING, timezone: 'UTC' }]) assert.throws(() => checkForecastPreprocessing(cleaning));

const origin='2026-10-06',now='2026-10-06T06:00:00Z';
assert(!dailyWorkComplete(origin, 1, [{ origin }], [], []), '02시 전에는 하루 완료로 고정하지 않음');
assert(!dailyWorkComplete(origin, 2, [], [], []), '예측 발행 실패는 다음 실행에서 재시도');
assert(!dailyWorkComplete(origin, 2, [{ origin }], ['2026-10-04'], []), '실측 확정 실패는 재시도');
assert(dailyWorkComplete(origin, 2, [{ origin }], ['2026-10-04'], [{ target: '2026-10-04' }]), '발행·도래 실측이 끝난 날만 완료');
assert(!dailyWorkComplete(shift(origin, 1), 2, [{ origin }], [], []), '다음 KST 날짜는 다시 발행');
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
