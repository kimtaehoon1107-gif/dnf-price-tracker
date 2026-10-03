import {H,D,avg,type Series} from './activity-study.ts';
import {direction} from './intraday-joint-forecast.ts';
export const LABELS=['하락','보합','상승'];
const pick=(counts:number[])=>[1,0,2].reduce((best,i)=>counts[i]>counts[best]?i:best,1);
export type Row={start:number;day:string;slot:number;hours:number;baseHours:number;actual:number|null;predictions:Record<string,number>;trainN:number;slotN:number;weekdayDays?:number;weekdaySlotDays?:number};
export function metrics(rows:Row[],model:string,threshold:number){
  const valid=rows.filter(r=>r.actual!=null),matrix=Array.from({length:3},()=>[0,0,0]);
  for(const r of valid)matrix[direction(r.actual!,threshold)][r.predictions[model]]++;
  const support=matrix.map(r=>r.reduce((a,b)=>a+b,0));
  return {model,n:valid.length,accuracy:valid.length?matrix.reduce((s,r,i)=>s+r[i],0)/valid.length:null,balancedAccuracy:avg(support.flatMap((n,i)=>n?[matrix[i][i]/n]:[])),support,matrix};
}
export function blockDirectionStudy(series:Series,cutoff:number,threshold=.5,width:3|6|12=6,includeWeekday=false){
  const STEP=width*H,minimumHours=Math.ceil(width*2/3);
  const buckets=new Map<number,{prices:number[];hours:Set<number>}>();
  for(const p of series.points){
    if(p.t+H>cutoff)continue;
    const start=Math.floor((p.t+3*H)/STEP)*STEP-3*H;
    if(!buckets.has(start))buckets.set(start,{prices:[],hours:new Set()});
    const b=buckets.get(start)!;b.prices.push(p.price);b.hours.add(p.t);
  }
  const block=(t:number)=>{const b=buckets.get(t);return b&&b.hours.size>=minimumHours&&t+STEP<=cutoff?{price:avg(b.prices)!,hours:b.hours.size}:null;};
  const starts=[...buckets.keys()].sort((a,b)=>a-b),rows:Row[]=[],skipped:any[]=[];
  const samples=starts.flatMap(start=>{const a=block(start-STEP),b=block(start);return a&&b?[{start,end:start+STEP,slot:((start/H+9)%24+24)%24,change:(b.price/a.price-1)*100}]:[]});
  if(starts.length)for(let start=starts[0];start<=cutoff;start+=STEP){
    const slot=((start/H+9)%24+24)%24,day=new Date(start+3*H).toISOString().slice(0,10),base=block(start-STEP),older=block(start-2*STEP);
    if(!base||!older){skipped.push({start,reason:'input_missing'});continue;}
    const train=samples.filter(s=>s.end<=start&&s.start>=start-28*D),same=train.filter(s=>s.slot===slot);
    if(train.length<7*24/width||same.length<4||train.at(-1)!.end-train[0].start<7*D){skipped.push({start,reason:'training_insufficient'});continue;}
    const counts=[0,0,0],local=[0,0,0];
    for(const s of train)counts[direction(s.change,threshold)]++;
    for(const s of same)local[direction(s.change,threshold)]++;
    // Four pooled pseudo-observations limit unstable slot estimates. Fixed before evaluation.
    const shrunk=local.map((n,i)=>n+4*counts[i]/train.length);
    const predictions:Record<string,number>={flat:1,down:0,up:2,majority:pick(counts),slot:pick(shrunk),momentum:direction((base.price/older.price-1)*100,threshold)};
    const extra:{weekdayDays?:number;weekdaySlotDays?:number}={};
    if(includeWeekday){
      const weekday=new Date(start+3*H).getUTCDay();
      const week=train.filter(s=>new Date(s.start+3*H).getUTCDay()===weekday);
      const joint=week.filter(s=>s.slot===slot);
      const dates=(ss:typeof train)=>new Set(ss.map(s=>new Date(s.start+3*H).toISOString().slice(0,10))).size;
      extra.weekdayDays=dates(week);extra.weekdaySlotDays=dates(joint);
      const wc=[0,0,0],jc=[0,0,0];
      for(const s of week)wc[direction(s.change,threshold)]++;
      for(const s of joint)jc[direction(s.change,threshold)]++;
      // Fixed shrinkage; sparse weekday cells fall back without dropping evaluation rows.
      predictions.weekday=extra.weekdayDays>=2?pick(wc.map((n,i)=>n+8*counts[i]/train.length)):predictions.majority;
      predictions.weekdaySlot=extra.weekdaySlotDays>=2?pick(jc.map((n,i)=>n+8*shrunk[i]/(same.length+4))):predictions.slot;
    }
    const target=block(start);
    rows.push({start,day,slot,hours:target?.hours??0,baseHours:base.hours,actual:target?(target.price/base.price-1)*100:null,predictions,trainN:train.length,slotN:same.length,...extra});
  }
  const models=['flat','down','up','majority','slot','momentum',...(includeWeekday?['weekday','weekdaySlot']:[])],score=(rs:Row[])=>models.map(m=>metrics(rs,m,threshold));
  return {id:series.id,name:series.name,threshold,width,issued:rows.length,scored:rows.filter(r=>r.actual!=null).length,days:new Set(rows.filter(r=>r.actual!=null).map(r=>r.day)).size,overall:score(rows),complete:score(rows.filter(r=>r.hours===width&&r.baseHours===width)),slots:Array.from({length:24/width},(_,i)=>(6+i*width)%24).map(slot=>({slot,models:score(rows.filter(r=>r.slot===slot))})),rows,skipped};
}
