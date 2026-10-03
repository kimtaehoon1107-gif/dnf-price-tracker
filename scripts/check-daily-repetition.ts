// 후향적 탐색: 기존 평균 경로를 본 뒤 정한 6시간 구간. 유의성/예측 성능 검정이 아니다.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepare,H,D,avg,med} from '../src/activity-study.ts';
const raw=readFileSync('data/intraday-study/activity-input.json','utf8'),input=JSON.parse(raw),cutoff=Date.parse(input.asOf);
const previous=JSON.parse(readFileSync('docs/evidence/full-day-20261001.json','utf8'));
const summarize=(days:any[])=>({n:days.length,medianDrop:med(days.map(d=>d.drop)),medianRecovery:med(days.map(d=>d.recovery)),thresholds:[0,.5,1].map(threshold=>({threshold,down:days.filter(d=>d.drop < -threshold).length,recovery:days.filter(d=>d.recovery > threshold).length,both:days.filter(d=>d.drop < -threshold&&d.recovery > threshold).length})),meanBlocks:[0,1,2,3].map(i=>avg(days.map(d=>d.blocks[i]/d.blocks[0]*100)))});
const results=prepare(input).filter(s=>s.id==='legendary:p10'||s.name==='레전더리 소울 결정').map(s=>{
  const map=new Map(s.points.filter(p=>p.t+H<=cutoff).map(p=>[p.t,p]));
  const dates=[...new Set([...map.keys()].map(t=>new Date(t+3*H).toISOString().slice(0,10)))].sort();
  const days:any[]=[],excluded:any[]=[];
  for(const day of dates){
    const start=Date.parse(day)-3*H;
    if(start+D>cutoff){excluded.push({day,reason:'incomplete_day'});continue;}
    const groups=Array.from({length:4},(_,b)=>Array.from({length:6},(_,h)=>map.get(start+(b*6+h)*H)).filter(p=>p!=null));
    if(groups.some(g=>g.length<4)){excluded.push({day,reason:'fewer_than_4_hours_in_block',counts:groups.map(g=>g.length)});continue;}
    const blocks=groups.map(g=>avg(g.map(p=>p.price))!);
    days.push({day,weekday:new Date(Date.parse(day)).getUTCDay(),hours:groups.reduce((n,g)=>n+g.length,0),known:groups.every(g=>g.every(p=>p.known)),blocks,drop:(blocks[1]/blocks[0]-1)*100,recovery:(blocks[3]/blocks[1]-1)*100,evening:(blocks[2]/blocks[1]-1)*100});
  }
  const oldDates=new Set(previous.results.find((r:any)=>r.id===s.id).paths.map((p:any)=>p.day));
  return {id:s.id,name:s.name,all:summarize(days),previousEvaluation:summarize(days.filter(d=>oldDates.has(d.day))),complete24:summarize(days.filter(d=>d.hours===24)),known:summarize(days.filter(d=>d.known)),weekdays:Array.from({length:7},(_,weekday)=>({weekday,...summarize(days.filter(d=>d.weekday===weekday))})),days,excluded};
});
const report={asOf:input.asOf,inputHash:createHash('sha256').update(raw).digest('hex'),blocks:['06–12','12–18','18–24','00–06 (+1 day)'],minimumHoursPerBlock:4,description:'Descriptive post-hoc comparison; rebound compares next-day 00–06 with same game-day 12–18. Thresholds require both legs. No interpolation, no causal or forecast claim.',results};
writeFileSync('docs/evidence/daily-repetition-20261002.json',JSON.stringify(report,null,2));
for(const r of results)console.log(JSON.stringify({name:r.name,all:r.all,previous:r.previousEvaluation,complete:r.complete24,known:r.known,weekdays:r.weekdays},null,2));
