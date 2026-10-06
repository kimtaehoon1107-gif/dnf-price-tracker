import assert from 'node:assert/strict';
import { forecast, type Point } from './forecast.ts';

export const VERSION = 'daily-vwap-20261006-v1';
export const MODELS = ['last','mean7','same_weekday','existing','ets_level','ets_damped','arima110','arima011','selected'];
export const day = (iso: string) => new Date(iso).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
export const shift = (d:string,n:number) => new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10);
export type Series = {id:string;name:string;daily:Point[]};
export function checkSnapshot(summary:any, now:string) {
  const age = Date.parse(now)-Date.parse(summary.priceAsOf);
  assert(Number.isFinite(age) && age>=0 && age<=3*3600000,'자료 기준 시각이 미래이거나 3시간 초과');
  assert(!summary.quality.stale && summary.quality.mismatches===0,'공개 집계 검사 실패');
  assert(day(summary.priceAsOf)===day(now) && day(summary.quality.through)===day(now),'당일 완료 집계 필요');
}
export function makeInput(series:Series[],origin:string) {
  const market = new Map(series.map(s=>[s.id,s.daily.filter(p=>p.d<origin && p.vwap>0 && p.n>0)]));
  const latest:any[] = [], excluded:any[] = [];
  for (const s of series) {
    const map = new Map(market.get(s.id)!.map(p=>[p.d,p]));
    const train:Point[]=[];
    for(let d=shift(origin,-1);map.has(d);d=shift(d,-1)) train.unshift(map.get(d)!);
    if(train.length<21 || train.reduce((n,p)=>n+p.n,0)/train.length<5) {
      excluded.push({id:s.id,name:s.name,reason:'연속 21일·일평균 거래 5건 미달',days:train.length}); continue;
    }
    latest.push({id:s.id,name:s.name,origin,train,existing:forecast(train,market,7,origin)!.points.map(p=>p.mid)});
  }
  return {before:origin,latest,excluded};
}
export function validateIssue(issue:any, now:string) {
  assert.equal(issue.version,VERSION);
  assert.equal(issue.origin,day(now),'지난 날짜 예측의 사후 발행 금지');
  assert.equal(day(issue.issuedAt),issue.origin);
  assert(Number.isFinite(Date.parse(issue.issuedAt)) && Date.parse(issue.issuedAt)<=Date.parse(now));
  for(const item of issue.items) {
    assert.deepEqual(item.predictions.map((p:any)=>p.h),[1,3,7]);
    for(const p of item.predictions) {
      assert.equal(p.d,shift(issue.origin,p.h));
      assert(Date.parse(issue.issuedAt)<Date.parse(p.d+'T00:00:00+09:00'));
      assert.deepEqual(Object.keys(p.values).sort(),[...MODELS].sort());
      for(const value of Object.values(p.values)) assert(typeof value==='number' && Number.isFinite(value) && value>0);
    }
  }
}
export function settle(target:string,series:Series[],ids:string[],now:string) {
  assert(target<=shift(day(now),-2),'대상일 종료 후 하루 대기 필요');
  return {version:VERSION,target,settledAt:now,values:Object.fromEntries(ids.map(id=>{
    const p=series.find(s=>s.id===id)?.daily.find(p=>p.d===target);
    return [id,p && p.n>=5 && p.vwap>0 ? {actual:p.vwap,n:p.n,reason:null} :
      {actual:null,n:p?.n??0,reason:p?'거래 5건 미만 또는 유효 가격 없음':'공개 일봉 없음'}];
  }))};
}
export function evaluate(issues:any[],actuals:any[]) {
  const rows:any[]=[],pending:any[]=[],excluded:any[]=[];
  for(const issue of issues) for(const item of issue.items) for(const p of item.predictions) {
    const settled=actuals.find(a=>a.target===p.d);
    const identity={origin:issue.origin,id:item.id,name:item.name,h:p.h,target:p.d};
    if(!settled) {pending.push(identity);continue;}
    const actual=settled.values[item.id];
    if(!actual?.actual) {excluded.push({...identity,reason:actual?.reason??'실측 기록에 품목 없음'});continue;}
    rows.push({...identity,actual:actual.actual,values:p.values});
  }
  const scores=[];
  for(const h of [1,3,7]) for(const model of MODELS) {
    const rr=rows.filter(r=>r.h===h), ids=[...new Set(rr.map(r=>r.id))];
    const error=(r:any,m:string)=>Math.abs(r.values[m]/r.actual-1)*100;
    const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
    const perItem=ids.map(id=>{const r=rr.filter(r=>r.id===id);return {id,n:r.length,mape:mean(r.map(r=>error(r,model))),baseline:mean(r.map(r=>error(r,'last')))};});
    scores.push({h,model,count:rr.length,items:ids.length,dates:new Set(rr.map(r=>r.target)).size,mape:mean(rr.map(r=>error(r,model))),itemMape:mean(perItem.map(i=>i.mape!)),perItem});
  }
  return {version:VERSION,scores,rows,pending,excluded};
}
