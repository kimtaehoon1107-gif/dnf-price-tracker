import {H,D,avg,predict,type Series} from './activity-study.ts';
import {MODELS,features,makeSamples,score,type ForecastRow} from './intraday-joint-forecast.ts';
type PathPoint=ForecastRow & {horizon:number;hour:number};
export function fullDayForecast(series:Series,cutoff:number){
  const points=series.points.filter(p=>p.t+H<=cutoff),map=new Map(points.map(p=>[p.t,p]));
  const samples=Array.from({length:24},(_,i)=>makeSamples(map,i+1));
  const coverage={calendarOrigins:0,inputMissing:0,trainingInsufficient:0,issued:0,scoredHours:0,days18:0,days24:0};
  const paths:{day:string;points:PathPoint[]}[]=[],skipped:{day:string;reason:string}[]=[];
  if(points.length){
    const first=Math.floor((Math.min(...points.map(p=>p.t))+9*H)/D)*D;
    for(let day=first;day-3*H<=cutoff;day+=D){
      const origin=day-4*H,label=new Date(day).toISOString().slice(0,10);coverage.calendarOrigins++;
      const p=map.get(origin),xs=Array.from({length:24},(_,i)=>features(map,origin,i+1));
      if(!p||xs.some(x=>!x)){coverage.inputMissing++;skipped.push({day:label,reason:'input_missing'});continue;}
      const trains=samples.map(ss=>ss.filter(s=>s.end<=origin&&s.t<origin&&s.t>=origin-28*D));
      if(trains.some(t=>t.length<120||t.at(-1)!.t-t[0].t<7*D)){coverage.trainingInsufficient++;skipped.push({day:label,reason:'training_insufficient'});continue;}
      // Entire trajectory is fixed using information through the 05:00 bar only.
      const forecasts=trains.map((train,i)=>({hold:p.price,trend:p.price*Math.exp(predict(train,xs[i]!,1)),clock:p.price*Math.exp(predict(train,xs[i]!,3)),stock:p.price*Math.exp(predict(train,xs[i]!,4)),yesterday:map.get(origin+(i+1)*H-D)?.price??null}));
      const rows=forecasts.map((predictions,i)=>{const target=map.get(origin+(i+1)*H);return {day:label,origin,base:p.price,actual:target?.price??null,known:[p,map.get(origin-24*H),map.get(origin-3*H),target].every(p=>p?.known),trainN:[trains[i].length],predictions,horizon:i+1,hour:(i+6)%24}});
      paths.push({day:label,points:rows});coverage.issued++;
    }
  }
  const hourly=Array.from({length:24},(_,i)=>{
    const rows=paths.map(p=>p.points[i]),valid=rows.filter(r=>r.actual!=null);
    return {horizon:i+1,hour:(i+6)%24,...score(rows),curve:{n:valid.length,actual:avg(valid.map(r=>r.actual!/r.base*100)),models:MODELS.map(model=>{const selected=valid.filter(r=>r.predictions[model]!=null);return {model,n:selected.length,index:avg(selected.map(r=>r.predictions[model]!/r.base*100))}})}};
  });
  const daily=paths.map(p=>{const valid=p.points.filter(r=>r.actual!=null);return {day:p.day,hours:valid.length,models:MODELS.map(model=>{
    const selected=valid.filter(r=>r.predictions[model]!=null);
    return {model,hours:selected.length,pathMAPE:avg(selected.map(r=>Math.abs(r.predictions[model]!/r.actual!-1)*100)),holdSameSample:avg(selected.map(r=>Math.abs(r.base/r.actual!-1)*100)),meanPriceAPE:selected.length===24?Math.abs(avg(selected.map(r=>r.predictions[model]!))!/avg(selected.map(r=>r.actual!))!-1)*100:null};
  })}});
  coverage.scoredHours=daily.reduce((s,d)=>s+d.hours,0);coverage.days18=daily.filter(d=>d.hours>=18).length;coverage.days24=daily.filter(d=>d.hours===24).length;
  const summary=MODELS.map(model=>{const ds=daily.flatMap(d=>{const m=d.models.find(m=>m.model===model)!;return m.hours>=18?[m]:[]}),complete=ds.filter(d=>d.hours===24);return {model,days18:ds.length,pathMAPE:avg(ds.map(d=>d.pathMAPE!)),holdSameSample:avg(ds.map(d=>d.holdSameSample!)),winsVsHold:ds.filter(d=>d.pathMAPE!<d.holdSameSample!).length,days24:complete.length,completePathMAPE:avg(complete.map(d=>d.pathMAPE!)),meanPriceMAPE:avg(complete.map(d=>d.meanPriceAPE!))}});
  return {id:series.id,name:series.name,coverage,summary,hourly,daily,paths,skipped};
}
