import fs from 'node:fs';
const root='docs/evidence/outlier-21day-20261008/';
const x=JSON.parse(fs.readFileSync(root+'cleaned-target-input.json'));
const old=JSON.parse(fs.readFileSync('docs/evidence/outlier-20261007/arima-input.json'));
const by=new Map(x.rows.filter(r=>r.method==='trade10x').map(r=>[r.item_id+'/'+r.day,r]));
const cases=[];let skipped=0;
for(const c of old.cases){
 if(c.basis!=='daily-trade-vwap'){cases.push(c);continue;}
 const rows=[...c.dates,c.d].map(d=>by.get(c.id+'/'+d));
 if(rows.some(r=>!r||r.kept_n<5||!(r.cleaned>0))){skipped++;continue;}
 cases.push({...c,train:{raw:rows.slice(0,21).map(r=>r.cleaned)},actual:rows[21].cleaned});
}
fs.writeFileSync(root+'arima-input.json',JSON.stringify({method:'trade10x-both',cases,skipped},null,2));console.log({cases:cases.length,skipped});
