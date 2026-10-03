import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {prepare,H,avg,type Series} from '../src/activity-study.ts';
import {direction} from '../src/intraday-joint-forecast.ts';
import {blockDirectionStudy,metrics,type Row} from '../src/block-direction-study.ts';
const raw=readFileSync('data/intraday-study/activity-input.json','utf8'),input=JSON.parse(raw);
const hourlyRaw=readFileSync('data/activity-research-verified/hourly.json','utf8'),hourly=JSON.parse(hourlyRaw);
const frozen=JSON.parse(readFileSync('docs/evidence/direction-widths-20261002.json','utf8'));
assert.deepEqual([raw,hourlyRaw].map(s=>createHash('sha256').update(s).digest('hex')),frozen.hashes);
const series:Series[]=prepare(input);
for(const s of hourly.filter((s:any)=>s.basis.includes('호가')))series.push({id:s.id+'/'+s.basis,name:s.name+' · '+s.basis,category:'카드',points:s.points.filter((p:any)=>p.price>0).map((p:any)=>({t:p.t,price:p.price,stock:0,known:false,clean:false})).sort((a:any,b:any)=>a.t-b.t)});
const models=['flat','majority','slot','weekday','weekdaySlot','momentum'];
function summarize(rows:Row[]){
  const valid=rows.filter(r=>r.actual!=null),days=[...new Set(valid.map(r=>r.day))];
  const base=(r:Row)=>r.predictions.slot===direction(r.actual!,.5),next=(r:Row)=>r.predictions.weekdaySlot===direction(r.actual!,.5);
  return {n:valid.length,days:days.length,weekdayUsed:valid.filter(r=>r.weekdayDays!>=2).length,jointUsed:valid.filter(r=>r.weekdaySlotDays!>=2).length,changed:valid.filter(r=>r.predictions.slot!==r.predictions.weekdaySlot).length,helped:valid.filter(r=>!base(r)&&next(r)).length,hurt:valid.filter(r=>base(r)&&!next(r)).length,models:models.map(m=>({...metrics(valid,m,.5),dayBalancedAccuracy:avg(days.map(day=>avg(valid.filter(r=>r.day===day).map(r=>Number(r.predictions[m]===direction(r.actual!,.5))))!))}))};
}
const results=series.map(s=>{
  const prior=frozen.results.find((r:any)=>r.id===s.id),width=prior.selectedWidth;
  if(width==null)return {id:s.id,name:s.name,category:s.category,width:null,reason:'prior_selection_insufficient'};
  const run=blockDirectionStudy(s,Date.parse(frozen.testEnd),.5,width,true);
  const rows=run.rows.filter(r=>r.start>=Date.parse(frozen.split)&&r.start+width*H<=Date.parse(frozen.testEnd));
  const expected=prior.candidates.find((c:any)=>c.width===width).rows.filter((r:Row)=>r.start>=Date.parse(frozen.split)&&r.start+width*H<=Date.parse(frozen.testEnd));
  assert.deepEqual(rows.map(r=>[r.start,r.actual,r.predictions.slot]),expected.map((r:Row)=>[r.start,r.actual,r.predictions.slot]));
  return {id:s.id,name:s.name,category:s.category,width,test:summarize(rows),weekdays:Array.from({length:7},(_,weekday)=>({weekday,...summarize(rows.filter(r=>new Date(r.start+3*H).getUTCDay()===weekday))})),rows};
});
writeFileSync('docs/evidence/weekday-directions-20261002.json',JSON.stringify({asOf:input.asOf,split:frozen.split,testEnd:frozen.testEnd,hashes:frozen.hashes,threshold:.5,shrinkage:8,minimumWeekdayDates:2,results}));
for(const r of results.filter(r=>r.category!=='카드'))console.log(JSON.stringify({name:r.name,width:r.width,test:r.test}));
