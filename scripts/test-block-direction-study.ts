import assert from 'node:assert/strict';
import {H,D,type Series} from '../src/activity-study.ts';
import {direction} from '../src/intraday-joint-forecast.ts';
import {blockDirectionStudy} from '../src/block-direction-study.ts';
const start=Date.parse('2026-09-01T21:00:00Z'); // 06 KST
const s:Series={id:'x',name:'x',category:'x',points:Array.from({length:24*22},(_,i)=>({t:start+i*H,price:100+Math.sin(i*Math.PI/12)*2,stock:1,known:true,clean:true}))};
const cutoff=start+22*D,r=blockDirectionStudy(s,cutoff),first=r.rows[0];
assert(first);assert.deepEqual([direction(-.5,.5),direction(.5,.5),direction(-.51,.5),direction(.51,.5)],[1,1,0,2]);
assert(r.rows.every(r=>[0,6,12,18].includes(r.slot)));
const changed={...s,points:s.points.map(p=>p.t>=first.start?{...p,price:p.price*4}:p)};
assert.deepEqual(blockDirectionStudy(changed,cutoff).rows[0].predictions,first.predictions);
const missing={...s,points:s.points.filter(p=>p.t<first.start||p.t>=first.start+3*H)};
const mr=blockDirectionStudy(missing,cutoff).rows.find(r=>r.start===first.start)!;
assert.equal(mr.actual,null);assert.deepEqual(mr.predictions,first.predictions);
const partial=blockDirectionStudy(s,first.start+2*H).rows.find(r=>r.start===first.start)!;
assert.equal(partial.actual,null);assert.deepEqual(partial.predictions,first.predictions);
for(const model of r.overall)assert.equal(model.matrix.flat().reduce((a,b)=>a+b,0),model.n);
assert.equal(new Date(r.rows.find(r=>r.slot===0)!.start+3*H).toISOString().slice(0,10),r.rows.find(r=>r.slot===0)!.day);
console.log('block direction: thresholds, future leakage, target missingness, partial blocks and game-day labels passed');
for(const width of [3,6,12] as const){
  const r=blockDirectionStudy(s,cutoff,.5,width),origin=r.rows[0].start;
  assert(r.rows.every(r=>(r.slot-6+24)%width===0),'all widths anchored at 06 KST');
  const changed={...s,points:s.points.map(p=>p.t>=origin?{...p,price:p.price*8}:p)};
  assert.deepEqual(blockDirectionStudy(changed,cutoff,.5,width).rows[0].predictions,r.rows[0].predictions);
  const split=start+16*D;
  const past=blockDirectionStudy(s,split,.5,width).rows.filter(r=>r.start+width*H<=split);
  assert.deepEqual(past,r.rows.filter(r=>r.start+width*H<=split),'later period cannot change validation rows');
  const week=blockDirectionStudy(s,cutoff,.5,width,true);
  assert.deepEqual(week.rows.map(r=>r.predictions.slot),r.rows.map(r=>r.predictions.slot));
  assert.deepEqual(blockDirectionStudy(changed,cutoff,.5,width,true).rows[0].predictions,week.rows[0].predictions);
  assert.deepEqual(blockDirectionStudy(s,split,.5,width,true).rows.filter(r=>r.start+width*H<=split),week.rows.filter(r=>r.start+width*H<=split));
  for(const row of week.rows){
    if(row.weekdaySlotDays!<2)assert.equal(row.predictions.weekdaySlot,row.predictions.slot);
    if(row.weekdayDays!<2)assert.equal(row.predictions.weekday,row.predictions.majority);
  }
}
