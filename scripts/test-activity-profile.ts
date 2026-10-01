import assert from 'node:assert/strict';
import {activityProfiles} from '../src/activity-profile.ts';
import {HOUR,DAY} from '../src/intraday-study.ts';
const start=Date.parse('2026-09-06T15:00:00Z');
const points=Array.from({length:16*24},(_,h)=>({t:start+h*HOUR,price:100+h%24}));
const item={id:'a',name:'a',category:'소울 결정',price:points,listings:points,stock:points,traded:points};
const run=i=>activityProfiles(i,new Date(start+16*DAY).toISOString())[0];
const full=run([item]);assert.equal(full.metrics.length,3);
assert.deepEqual(full.metrics[0].profile,full.metrics[1].profile);
const sparse={...item,traded:points.filter((_,i)=>i%24>=7)};
assert(full.metrics[0].profile.days>0);assert(run([sparse]).metrics.every(m=>m.profile.days===0));
const gap={...item,stock:points.filter((_,i)=>i!==12)};
const joint=run([gap]);for(const m of joint.metrics)assert.equal(m.profile.boundaries[0].hourly[12].n,14);
const zero={...item,stock:points.map(p=>({...p,price:0}))};assert(run([zero]).metrics.every(m=>m.profile.days===0));
const zeroDay={...item,stock:points.map(p=>({...p,price:p.t>=start+DAY&&p.t<start+2*DAY?0:p.price}))};
const mixed=run([item,{...zeroDay,id:'b'}]);
for(const m of mixed.metrics){
  assert.deepEqual(m.profile.dates,mixed.metrics[0].profile.dates);
  for(let b=0;b<2;b++)assert.deepEqual(m.profile.boundaries[b].hourly.map(h=>h.n),mixed.metrics[0].profile.boundaries[b].hourly.map(h=>h.n));
}
assert(mixed.metrics[0].profile.days<full.metrics[0].profile.days);
const lg=activityProfiles([{...item,id:'legendary:p10',traded:[]}],new Date(start+16*DAY).toISOString())[2];
assert.deepEqual(lg.metrics.map(m=>m.metric),['price','listings']);
assert(lg.metrics[0].profile.days>0);
console.log('activity: identical dates/hours, missing trades, zero stock, legendary separation passed');
