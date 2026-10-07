import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const root='docs/evidence/outlier-21day-20261008/';
const archive=JSON.parse(readFileSync(root+'input.json'));
const live=JSON.parse(readFileSync('docs/evidence/outlier-20261007/cleaned-target-input.json'));
const prior=JSON.parse(readFileSync('docs/evidence/outlier-20261007/input.json'));
const rows=[...archive.rows.filter(r=>r.day<='2026-09-22'),...live.rows.filter(r=>r.day>='2026-09-23')];
assert.equal(new Set(rows.map(r=>[r.item_id,r.day,r.method].join('/'))).size,rows.length);
let matched=0;const mismatches=[];
for(const r of rows.filter(r=>r.method==='raw')){
 const p=prior.items.find(i=>i.id===r.item_id)?.points.find(p=>p.d===r.day);
 if(!p)continue;
 if(p.n!==r.n||p.qty!==r.qty||Math.abs(p.vwap/r.original-1)>1e-8)mismatches.push({id:r.item_id,day:r.day,n:[p.n,r.n],qty:[p.qty,r.qty],vwap:[p.vwap,r.original]});
 else matched++;
}
const bad=new Set(mismatches.map(r=>r.id+'/'+r.day));
const result={from:'2026-09-08',through:'2026-10-06',sources:archive.sources,liveCollectedAt:live.collectedAt,items:live.items,rows:rows.filter(r=>!bad.has(r.item_id+'/'+r.day)),verification:{matched,mismatches,rule:'mismatched days excluded from every method, no interpolation'}};
writeFileSync(root+'cleaned-target-input.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({matched,mismatches,rows:result.rows.length}));
