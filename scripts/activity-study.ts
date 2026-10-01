import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepare,repetition,forecast,avg,med,summarize,H,type Mode} from '../src/activity-study.ts';
const inputText=readFileSync('data/intraday-study/activity-input.json','utf8'),input=JSON.parse(inputText);
const series=prepare(input),cutoff=Date.parse(input.asOf),modes:Mode[]=['all','noThursday','known','overlap','clean'];
const groups=['소울 결정','유랑악단 패키지','레전더리 P10'].map(name=>{
  const members=series.filter(s=>s.category===name),metrics=name==='레전더리 P10'?['price','stock'] as const:['price','traded','stock'] as const;
  return {name,coverage:members.map(s=>({name:s.name,hours:s.points.length,known:s.points.filter(p=>p.known).length,clean:s.points.filter(p=>p.clean).length})),
    comparisons:metrics.map(metric=>{const baseline=repetition(members,metric,cutoff);return {metric,results:[0,6].flatMap(boundary=>modes.map(mode=>({boundary,mode,...repetition(members,metric,cutoff,boundary,mode)}))),
      individual:members.map((s,i)=>({name:s.name,...summarize(baseline.daily.map((d:any)=>({day:d.day,pct:d.components[i]})))})),
      leaveOneOut:members.length>1?members.map((s,i)=>({omitted:s.name,...summarize(baseline.daily.map((d:any)=>({day:d.day,pct:avg(d.components.filter((_:number,j:number)=>j!==i))!})))})):[]};})};
});
const legendary=series.find(s=>s.id==='legendary:p10')!;
const forecasts=modes.filter(m=>m!=='overlap').map(mode=>({mode,results:[1,3,6].map(h=>forecast(legendary.points.filter(p=>mode==='known'?p.known:mode==='clean'?p.clean:mode==='noThursday'?new Date(p.t+9*H).getUTCDay()!==4:true),h))}));
// 같은 카드 집합에서 다시 계산한 P10과 전체 P10의 시간 변화 비교. 인과 분해가 아니다.
const scanHours=new Map<number,any>();
for(const {table,row:r} of input.rows)if(table==='legendary_card_scans'&&r.status==='complete'&&r.finished_at&&Date.parse(r.finished_at)<cutoff){
  const t=Math.floor(Date.parse(r.finished_at)/H)*H,old=scanHours.get(t);
  if(!old||Date.parse(r.finished_at)>Date.parse(old.finished_at))scanHours.set(t,r);
}
const values=(r:any)=>new Map<string,number>(r.observations.filter((o:any)=>o.status==='observed'&&o.minPrice>0).map((o:any)=>[o.itemId,Number(o.minPrice)]));
const quantile=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length*.1)];
const composition=[];
for(const [t,s] of scanHours){const before=scanHours.get(t-H);if(!before)continue;
  const a=values(before),b=values(s),common=[...a.keys()].filter(id=>b.has(id));if(common.length<20)continue;
  const raw=Math.log(quantile([...b.values()])/quantile([...a.values()]))*100,matched=Math.log(quantile(common.map(id=>b.get(id)!))/quantile(common.map(id=>a.get(id)!)))*100;
  composition.push({t,common:common.length,before:a.size,after:b.size,raw,matched,difference:raw-matched});
}
const report={asOf:input.asOf,inputHash:createHash('sha256').update(inputText).digest('hex'),sources:input.sources,rules:{exploratory:true,windows:'KST 06–08 vs 18–20, each >=2 shared hours; each member >=18 observed hours/day. Individual and leave-one-out use identical baseline days and hours.',quality:'known: successful records with no recorded failure in hour; overlap: additionally no disjoint saturated flag or 400-listing cap; clean: additionally exclude every 100-row sold response. Missing records excluded, full completeness not guaranteed. A 100-row response alone does not prove missing trades.',forecast:'P10 only, exact 1/3/6-hour endpoints, >=7 days and >=100 training samples; expanding ridge penalty=1; price hold / price return / price+stock return. Historical reconstruction, not live-issued evaluation.'},groups,forecasts,
 composition:{pairs:composition.length,first:composition.length?new Date(Math.min(...composition.map(p=>p.t))).toISOString():null,last:composition.length?new Date(Math.max(...composition.map(p=>p.t))).toISOString():null,medianCommon:med(composition.map(p=>p.common)),meanAbsDifference:avg(composition.map(p=>Math.abs(p.difference))),different:composition.filter(p=>Math.abs(p.difference)>1e-8).length,observations:composition}};
writeFileSync('data/intraday-study/activity-results.json',JSON.stringify(report));
writeFileSync('data/intraday-study/activity-summary.json',JSON.stringify(report,(key,value)=>['predictions','observations','daily'].includes(key)?undefined:value,2));
for(const g of groups){console.log(g.name,g.coverage);for(const c of g.comparisons)console.log(c.metric,c.results.filter(r=>r.boundary===6).map(({daily,...r})=>r));}
console.log('forecast',forecasts.map(f=>({mode:f.mode,results:f.results.map(({predictions,daily,...r})=>r)})));
console.log('composition',((({observations,...r})=>r)(report.composition)));
