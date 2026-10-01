import {H,D,avg,med,predict,type Observation,type Series} from './activity-study.ts';
export const MODELS=['hold','trend','clock','stock','yesterday'] as const;
type Model=typeof MODELS[number];
type Sample={t:number;end:number;x:number[];y:number};
export type ForecastRow={day:string;origin:number;base:number;actual:number|null;known:boolean;trainN:number[];predictions:Record<Model,number|null>};
const dayLabel=(t:number)=>new Date(t+9*H).toISOString().slice(0,10);
export function features(map:Map<number,Observation>,t:number,h:number){
  const p=map.get(t),a=map.get(t-24*H),b=map.get(t-3*H);
  if(!p||!a||!b||![p.price,a.price].every(v=>v>0)||![p.stock,b.stock].every(v=>Number.isFinite(v)&&v>=0))return null;
  const phase=((t/H+9)%24)*2*Math.PI/24,future=phase+h*2*Math.PI/24;
  return [Math.log(p.price/a.price)*h/24,Math.sin(future)-Math.sin(phase),Math.cos(future)-Math.cos(phase),Math.log((1+p.stock)/(1+b.stock))];
}
export function makeSamples(map:Map<number,Observation>,h:number):Sample[]{
  return [...map.keys()].sort((a,b)=>a-b).flatMap(t=>{const x=features(map,t,h),next=map.get(t+h*H);return x&&next&&next.price>0?[{t,end:next.t,x,y:Math.log(next.price/map.get(t)!.price)}]:[]});
}
export function studySeries(series:Series,cutoff:number){
  const points=series.points.filter(p=>p.t+H<=cutoff),map=new Map(points.map(p=>[p.t,p])),samples=[10,11,12].map(h=>makeSamples(map,h));
  const coverage={calendarOrigins:0,inputMissing:0,trainingInsufficient:0,issued:0,targetMissing:0,scored:0};
  const rows:ForecastRow[]=[],skipped:{day:string;reason:string}[]=[];
  if(!points.length)return {id:series.id,name:series.name,category:series.category,coverage,rows,skipped};
  const first=Math.floor((Math.min(...points.map(p=>p.t))+9*H)/D)*D;
  for(let day=first;day-H+H<=cutoff;day+=D){
    const origin=day-H,label=dayLabel(origin);coverage.calendarOrigins++;
    const x=[10,11,12].map(h=>features(map,origin,h)),p=map.get(origin);
    if(!p||x.some(v=>!v)){coverage.inputMissing++;skipped.push({day:label,reason:'input_missing'});continue;}
    const trains=samples.map(s=>s.filter(r=>r.end<=origin&&r.t<origin&&r.t>=origin-28*D));
    if(trains.some(t=>t.length<120||t.at(-1)!.t-t[0].t<7*D)){coverage.trainingInsufficient++;skipped.push({day:label,reason:'training_insufficient'});continue;}
    // Forecasts use origin-known data only. Targets are consulted after predictions are fixed.
    const predictions:Record<Model,number|null>={hold:p.price,trend:null,clock:null,stock:null,yesterday:null};
    for(const [model,dimensions] of [['trend',1],['clock',3],['stock',4]] as const)
      predictions[model]=avg(trains.map((train,i)=>p.price*Math.exp(predict(train,x[i]!,dimensions))))!;
    const yesterdayBase=map.get(origin-D),yesterdayTargets=[10,11,12].map(h=>map.get(origin-D+h*H));
    if(yesterdayBase&&yesterdayTargets.every(p=>p))predictions.yesterday=p.price*avg(yesterdayTargets.map(p=>p!.price))!/yesterdayBase.price;
    coverage.issued++;
    const targets=[10,11,12].map(h=>map.get(origin+h*H));
    const actual=targets.every(p=>p)?avg(targets.map(p=>p!.price)):null;
    if(actual==null)coverage.targetMissing++;else coverage.scored++;
    const known=[p,map.get(origin-24*H),map.get(origin-3*H),...targets].every(p=>p?.known);
    rows.push({day:label,origin,base:p.price,actual,known,trainN:trains.map(t=>t.length),predictions});
  }
  return {id:series.id,name:series.name,category:series.category,coverage,rows,skipped};
}
export function direction(change:number,threshold:number){return change>threshold+1e-9?2:change< -threshold-1e-9?0:1;}
export function classify(actual:number[],predicted:number[],threshold:number){
  const matrix=Array.from({length:3},()=>[0,0,0]);
  actual.forEach((x,i)=>matrix[direction(x,threshold)][direction(predicted[i],threshold)]++);
  const support=matrix.map(r=>r.reduce((a,b)=>a+b,0)),recall=support.flatMap((n,i)=>n?[matrix[i][i]/n]:[]);
  return {n:actual.length,accuracy:actual.length?matrix.reduce((s,r,i)=>s+r[i],0)/actual.length:null,balancedAccuracy:avg(recall),support,matrix};
}
const ape=(row:ForecastRow,m:Model)=>Math.abs(row.predictions[m]!/row.actual!-1)*100;
export function score(rows:ForecastRow[]){
  const valid=rows.filter(r=>r.actual!=null),truth=valid.map(r=>(r.actual!/r.base-1)*100);
  return {days:valid.length,from:valid[0]?.day??null,to:valid.at(-1)?.day??null,
    models:MODELS.map(model=>{
      const selected=valid.filter(r=>r.predictions[model]!=null),errors=selected.map(r=>ape(r,model)),sorted=[...errors].sort((a,b)=>a-b);
      return {model,n:selected.length,mape:avg(errors),medianAPE:med(errors),p90APE:sorted.length?sorted[Math.floor(.9*(sorted.length-1))]:null,biasPct:avg(selected.map(r=>(r.predictions[model]!/r.actual!-1)*100)),winsVsHold:selected.filter(r=>ape(r,model)<ape(r,'hold')).length,holdSameSample:avg(selected.map(r=>ape(r,'hold'))),
        direction:[0,.5,1].map(threshold=>({threshold,...classify(selected.map(r=>(r.actual!/r.base-1)*100),selected.map(r=>(r.predictions[model]!/r.base-1)*100),threshold)}))};
    }),constantDirections:[0,.5,1].map(threshold=>({threshold,down:classify(truth,truth.map(()=>-100),threshold),flat:classify(truth,truth.map(()=>0),threshold),up:classify(truth,truth.map(()=>100),threshold)}))};
}
// Paired calendar-block resampling preserves model comparisons; few blocks => exploratory only.
export function paired(rows:ForecastRow[],a:Model,b:Model){
  const valid=rows.filter(r=>r.actual!=null&&r.predictions[a]!=null&&r.predictions[b]!=null),blocks=new Map<number,number[]>();
  if(!valid.length)return {a,b,n:0,meanDifference:null,blocks:0,interval95:null};
  const first=Date.parse(valid[0].day);
  for(const r of valid){const key=Math.floor((Date.parse(r.day)-first)/(3*D));if(!blocks.has(key))blocks.set(key,[]);blocks.get(key)!.push(ape(r,a)-ape(r,b));}
  const groups=[...blocks.values()],boot:number[]=[];let seed=20261001;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  if(groups.length>=4)for(let i=0;i<2000;i++)boot.push(avg(groups.flatMap(()=>groups[Math.floor(random()*groups.length)]))!);
  boot.sort((a,b)=>a-b);
  return {a,b,n:valid.length,meanDifference:avg(groups.flat()),blocks:groups.length,interval95:boot.length?[boot[50],boot[1949]]:null};
}
