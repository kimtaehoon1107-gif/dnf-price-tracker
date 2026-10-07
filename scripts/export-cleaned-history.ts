// Verified archive reads only; no production DB, API or archive writes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {r2Store,projectArchiveStore,readManifest,readRows} from '../src/archive.ts';
const config=JSON.parse(readFileSync('config/history-sources.json','utf8'));
const root=r2Store(),sources:any[]=[],items=new Map<string,any>(),bins=new Map<string,any[]>();
const owns=(source:string,t:number,id:string)=>config.owners.some((o:any)=>o.itemId===id&&o.source===source&&(o.from==null||t>=Date.parse(o.from))&&(o.to==null||t<Date.parse(o.to)));
for(const source of [{schema:'hist_a',project:null,manifest:config.frozen.manifest},...config.live]){
 const store=source.project?projectArchiveStore(root,source.project):root;
 const saved=await readManifest(store,source.manifest);assert(saved);
 assert(await store.get(`verified/${saved.id.slice(10,-5)}.json`));
 sources.push({source:source.schema,manifest:saved.id,asOf:saved.manifest.createdAt});
 for(const s of saved.manifest.shards.filter(s=>s.table==='items'))for(const raw of await readRows(store,s)){
  const r=JSON.parse(raw.row);if(r.tracked&&r.category!=='카드')items.set(r.item_id,{id:r.item_id,name:r.item_name,category:r.category,basis:'daily-trade-vwap'});
 }
 const shards=saved.manifest.shards.filter(s=>s.table==='trades'&&s.day>='2026-09-07'&&s.day<='2026-09-22');
 let next=0;const seen=new Set<string>();
 await Promise.all(Array.from({length:4},async()=>{
  while(next<shards.length){const s=shards[next++];for(const raw of await readRows(store,s)){
   assert(!seen.has(raw.key),'duplicate archived trade id');seen.add(raw.key);
   const r=JSON.parse(raw.row),t=Date.parse(r.sold_date);
   if(!items.has(r.item_id)||!owns(source.schema,t,r.item_id))continue;
   const day=new Date(t+9*3600000).toISOString().slice(0,10);
   if(day<'2026-09-08'||day>'2026-09-22')continue;
   const u=Number(r.unit_price),qty=Number(r.count);assert(u>0&&qty>0);
   const key=r.item_id+'/'+day;if(!bins.has(key))bins.set(key,[]);bins.get(key)!.push({u,qty});
  }}
 }));
 console.log(source.schema,shards.length,'verified trade shards');
}
assert(sources.filter(s=>s.source!=='hist_a').every(s=>Date.parse(s.asOf)>=Date.parse('2026-09-22T15:00:00Z')));
const quantile=(xs:number[],q:number)=>{const a=[...xs].sort((a,b)=>a-b),p=(a.length-1)*q,i=Math.floor(p);return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*(p-i);};
const rows:any[]=[];
for(const [key,trades]of bins){
 const [item_id,day]=key.split('/'),us=trades.map(r=>r.u),n=us.length,med=quantile(us,.5),q1=quantile(us,.25),q3=quantile(us,.75);
 const mu=us.reduce((s,v)=>s+v,0)/n,sd=Math.sqrt(us.reduce((s,v)=>s+(v-mu)**2,0)/n),mad=quantile(us.map(u=>Math.abs(u-med)),.5);
 const qty=trades.reduce((s,r)=>s+r.qty,0),original=trades.reduce((s,r)=>s+r.u*r.qty,0)/qty;
 for(const method of ['raw','iqr','mad','zscore','trade10x']){
  const kept=trades.filter(({u})=>method==='raw'||(method==='trade10x'?u>=med/10&&u<=med*10:method==='iqr'?q1===q3||u>=q1-1.5*(q3-q1)&&u<=q3+1.5*(q3-q1):method==='mad'?mad===0||Math.abs(u-med)<=3*1.4826*mad:sd===0||Math.abs(u-mu)<=3*sd));
  const kept_qty=kept.reduce((s,r)=>s+r.qty,0);
  rows.push({item_id,day,method,n,qty,median:med,original,low:Math.min(...us),high:Math.max(...us),kept_n:kept.length,kept_qty,cleaned:kept_qty?kept.reduce((s,r)=>s+r.u*r.qty,0)/kept_qty:null});
 }
}
mkdirSync('data/cleaned-history',{recursive:true});
writeFileSync('data/cleaned-history/input.json',JSON.stringify({sources,from:'2026-09-08',through:'2026-09-22',items:[...items.values()],rows},null,2));
console.log('Exported',bins.size,'item-days',rows.length,'method aggregates');
