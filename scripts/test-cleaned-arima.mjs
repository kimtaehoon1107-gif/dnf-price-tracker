import fs from 'node:fs';
import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p));
const root='docs/evidence/';
const source=read(root+'outlier-21day-20261008/cleaned-target-input.json');
const input=read(root+'outlier-21day-20261008/arima-input.json');
const result=read(root+'arima-orders-cleaned-20261008/results.json');
const by=new Map(source.rows.filter(r=>r.method==='trade10x').map(r=>[r.item_id+'/'+r.day,r]));
for(const c of input.cases){
 assert.equal(c.dates.length,21);
 for(let j=1;j<c.dates.length;j++)assert.equal(Date.parse(c.dates[j])-Date.parse(c.dates[j-1]),86400000);
 assert.equal(Date.parse(c.d)-Date.parse(c.dates.at(-1)),86400000);
 if(c.basis==='daily-trade-vwap'){
  assert.deepEqual(c.train.raw,c.dates.map(d=>by.get(c.id+'/'+d).cleaned));
  assert.equal(c.actual,by.get(c.id+'/'+c.d).cleaned);
 }
 const rows=result.rows.filter(r=>r.id===c.id&&r.d===c.d);
 assert.equal(rows.length,14);
 for(const r of rows){assert.equal(r.actual,c.actual);assert.equal(r.ape,Math.abs(r.pred/r.actual-1)*100);}
 assert.equal(rows.find(r=>r.model==='last').pred,c.train.raw.at(-1));
}
const spike=by.get('c4816db14d145416921f0210063cb014/2026-10-06');
assert.equal(spike.n-spike.kept_n,5);assert.equal(spike.qty-spike.kept_qty,44);
assert(Math.abs(spike.cleaned-1426.306048)<.001);
console.log('PASS: 21 consecutive training days, all training and target prices filtered, identical 14-model cases, spike excluded');
