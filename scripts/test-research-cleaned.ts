import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { researchExport } from '../src/research-export.ts';
import { loadResearch, PACKAGE_ID, PART_IDS } from '../src/research-data.ts';
const sqls: string[]=[];
const client:any={query:async(sql:string)=>{
  sqls.push(sql);
  if(sql.includes('FROM display.candles_1h')||sql.includes('FROM candles_1h'))return {rows:[PACKAGE_ID,...PART_IDS,'0620c107b1aae1f3a6cf9eee3aaf43d7'].map(item_id=>({item_id,d:'2026-10-01',value:sql.includes('display.')?100:1000,qty:5,n:5}))};
  return {rows:[]};
}};
const at='2026-10-08T00:00:00Z';
const raw=await loadResearch(client,at,at);
assert.equal(raw.trade[0].value,1000,'default research input stays original');
assert(!sqls.some(s=>s.includes('display.')));
const display=await researchExport(client,at,at,undefined,true);
assert.equal(display.cleaning,'daily-median-10x-v1');
assert.equal(display.package.daily[0].price,100);
assert.equal(display.package.daily[0].parts,500);
const soul=display.series.find(s=>s.id==='soul')!;
const member=soul.members!.find(m=>m.id==='0620c107b1aae1f3a6cf9eee3aaf43d7')!;
assert.equal(member.daily[0].value,100/member.base*100);
assert(soul.originalDaily,'original observations kept separate from cleaned display');
const data=JSON.parse(readFileSync('web/forecast-review.json','utf8'));
assert.equal(data.cleaning,'daily-median-10x-v1');
const evidence=JSON.parse(readFileSync('docs/evidence/arima-orders-cleaned-20261008/results.json','utf8'));
for(const item of data.items)for(const r of item.rows.filter(r=>r.h===1))for(const [key,model] of Object.entries({last:'last',arima110:'110',weekday_arima:'110 + weekday'})){
 const expected=evidence.rows.find(e=>e.name===item.name&&e.d===r.target&&e.model===model);
 assert(expected);
 assert.equal(r.actual,expected.actual);
 assert(Math.abs(r.pred[key]/expected.pred-1)<1e-8);
 assert.equal(r.failed.includes(key),expected.failed);
}
console.log('Cleaned research: separate input, package/member values, original protocol and published ARIMA evidence passed');
