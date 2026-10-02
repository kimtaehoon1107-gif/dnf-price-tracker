import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepare,H,type Series} from '../src/activity-study.ts';
import {blockDirectionStudy,metrics,type Row} from '../src/block-direction-study.ts';
const raw=readFileSync('data/intraday-study/activity-input.json','utf8'),input=JSON.parse(raw);
const hourlyRaw=readFileSync('data/activity-research-verified/hourly.json','utf8'),hourly=JSON.parse(hourlyRaw);
const meta=JSON.parse(readFileSync('data/activity-research-verified/report.json','utf8'));
if(meta.asOf!==input.asOf)throw new Error('Input cutoffs differ');
const series:Series[]=prepare(input);
for(const s of hourly.filter((s:any)=>s.basis.includes('호가'))){
  series.push({id:s.id+'/'+s.basis,name:s.name+' · '+s.basis,category:'카드',points:s.points.filter((p:any)=>p.price>0).map((p:any)=>({t:p.t,price:p.price,stock:0,known:false,clean:false})).sort((a:any,b:any)=>a.t-b.t)});
}
const split=Date.parse('2026-09-24T21:00:00Z'),end=Date.parse('2026-09-30T21:00:00Z'); // 09-25 06 → 10-01 06 KST
const summarize=(rows:Row[])=>({n:rows.length,days:new Set(rows.map(r=>r.day)).size,models:['flat','down','up','majority','slot','momentum'].map(m=>metrics(rows,m,.5))});
const results=series.map(s=>{
  const candidates=([6,3,12] as const).map(width=>{
    const r=blockDirectionStudy(s,Math.min(Date.parse(input.asOf),end),.5,width);
    const valid=r.rows.filter(r=>r.actual!=null);
    const validation=summarize(valid.filter(r=>r.start+width*H<=split));
    const test=summarize(valid.filter(r=>r.start>=split&&r.start+width*H<=end));
    const eligible=validation.days>=5&&validation.n>=5*24/width&&validation.models[0].support.every(n=>n>0);
    const skill=eligible?validation.models.find(m=>m.model==='slot')!.balancedAccuracy!-validation.models.find(m=>m.model==='majority')!.balancedAccuracy!:null;
    return {width,validation,test,eligible,skill,rows:r.rows};
  });
  const ranked=candidates.filter(c=>c.eligible).sort((a,b)=>b.skill!-a.skill!);
  const chosen=ranked[0]??null;
  return {id:s.id,name:s.name,category:s.category,selectedWidth:chosen?.width??null,reason:chosen?'selected_using_pre_split_only':'insufficient_validation_dates_or_classes',candidates};
});
const report={asOf:input.asOf,split:new Date(split).toISOString(),testEnd:new Date(end).toISOString(),hashes:[raw,hourlyRaw].map(s=>createHash('sha256').update(s).digest('hex')),threshold:.5,results};
writeFileSync('docs/evidence/direction-widths-20261002.json',JSON.stringify(report));
for(const r of results){const c=r.candidates.find(c=>c.width===r.selectedWidth);console.log(JSON.stringify({name:r.name,category:r.category,width:r.selectedWidth,validation:c?.validation.n,test:c?.test.n,days:c?.test.days,models:c?.test.models.map(m=>({model:m.model,accuracy:m.accuracy,balanced:m.balancedAccuracy}))}));}
