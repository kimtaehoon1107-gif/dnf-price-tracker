import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {r2Store,projectArchiveStore,readManifest,readRows} from '../src/archive.ts';
const H=3600000,D=24*H;
const from=Date.parse('2026-09-13T06:00:00+09:00'),to=Date.parse('2026-10-13T06:00:00+09:00');
const day=(t:number)=>new Date(t+3*H).toISOString().slice(0,10);
assert.equal(day(from-1),'2026-09-12');assert.equal(day(from),'2026-09-13');assert.equal(day(from+D-1),'2026-09-13');
const config=JSON.parse(await readFile('config/history-sources.json','utf8'));
const root=r2Store(),sources=[],items=new Map<string,any>(),trades=new Map<string,any>(),candles:any[]=[];
let duplicates=0,bytes=0;
for(const s of [{schema:'hist_a',manifest:config.frozen.manifest},...config.live]){
 const store=s.project?projectArchiveStore(root,s.project):root;
 const saved=await readManifest(store,s.manifest);assert(saved);
 assert(await store.get(`verified/${saved.id.slice(10,-5)}.json`),'Unverified archive');
 assert(Date.parse(saved.manifest.createdAt)>=to||s.schema==='hist_a');
 const shards=saved.manifest.shards.filter(r=>r.table==='items'||(['trades','candles_1h'].includes(r.table)&&r.day>=new Date(from).toISOString().slice(0,10)&&r.day<=new Date(to).toISOString().slice(0,10)));
 bytes+=shards.reduce((a,r)=>a+r.bytes,0);assert(bytes<150000000,'Read limit exceeded');
 let cursor=0,tradeRows=0;
 await Promise.all(Array.from({length:6},async()=>{while(cursor<shards.length){const shard=shards[cursor++];for(const ar of await readRows(store,shard)){
  const r=JSON.parse(ar.row);
  if(shard.table==='items'){if(config.owners.some((o:any)=>o.itemId===r.item_id&&o.source===s.schema&&o.to==null))items.set(r.item_id,r);continue;}
  const t=Date.parse(r.sold_date??r.hour);if(t<from||t>=to)continue;
  if(shard.table==='candles_1h'){candles.push({source:s.schema,...r});continue;}
  const key=JSON.stringify([r.item_id,t,r.unit_price,r.count,r.reinforce,r.dup_seq]);
  const prior=trades.get(key);if(prior){assert.equal(String(prior.price),String(r.price));assert.equal(prior.refine,r.refine);assert.equal(prior.amplification_name,r.amplification_name);duplicates++;}else trades.set(key,r);
  tradeRows++;
 }}}));
 sources.push({source:s.schema,asOf:saved.manifest.createdAt,shards:shards.length,tradeRows});
 console.log('READ',JSON.stringify(sources.at(-1)));
}
const selected=new Map([...items].filter(([id,r])=>r.tracked&&r.category!=='카드'));
const daily=new Map<string,any>();for(let t=from;t<to;t+=D)daily.set(day(t),{day:day(t),start:new Date(t).toISOString(),end:new Date(t+D).toISOString(),amount:0n,qty:0,trades:0,items:new Set(),hours:new Set(),candleShortfalls:0});
const hourly=new Map<string,{n:number;qty:number}>(),perItem=new Map<string,any>();
for(const r of trades.values()){
 if(!selected.has(r.item_id))continue;const t=Date.parse(r.sold_date),k=day(t),d=daily.get(k);assert(d);
 const amount=BigInt(r.unit_price)*BigInt(r.count);d.amount+=amount;d.qty+=Number(r.count);d.trades++;d.items.add(r.item_id);d.hours.add(Math.floor(t/H));
 const hk=r.item_id+'|'+Math.floor(t/H),h=hourly.get(hk)||{n:0,qty:0};h.n++;h.qty+=Number(r.count);hourly.set(hk,h);
 const ik=r.item_id+'|'+k,p=perItem.get(ik)||{id:r.item_id,name:selected.get(r.item_id).item_name,day:k,amount:0n,trades:0};p.amount+=amount;p.trades++;perItem.set(ik,p);
}
let checkedHours=0,shortfalls=0,boundaryHours=0;
for(const r of candles){if(!selected.has(r.item_id))continue;const t=Date.parse(r.hour),owner=config.owners.find((o:any)=>o.itemId===r.item_id&&o.source===r.source&&(o.from==null||t>=Date.parse(o.from))&&(o.to==null||t+H<=Date.parse(o.to)));if(!owner){boundaryHours++;continue;}
 checkedHours++;const h=hourly.get(r.item_id+'|'+Math.floor(t/H));if((h?.n||0)<Number(r.n)||(h?.qty||0)<Number(r.qty)){shortfalls++;daily.get(day(t)).candleShortfalls++;}
}
const ranking=JSON.parse(await readFile('data/top100-r2-inspection/rows.json','utf8'));const latestAt=ranking.at(-1).capturedAt,latest=ranking.filter((r:any)=>r.capturedAt===latestAt);
const report={method:'Observed raw trades, natural-key union across A/B/C; KST 06:00 inclusive to next 06:00 exclusive; current tracked non-card items; no extrapolation, no outlier removal',sources,bytes,duplicates,checkedHours,shortfalls,boundaryHours,trackedItems:selected.size,latestTop100Covered:latest.filter((r:any)=>selected.has(r.id)).length,latestTop100Missing:latest.filter((r:any)=>!selected.has(r.id)).map((r:any)=>({id:r.id,name:r.name})),daily:[...daily.values()].map(r=>({...r,amount:r.amount.toString(),items:r.items.size,hours:r.hours.size})),perItem:[...perItem.values()].map(r=>({...r,amount:r.amount.toString()}))};
await mkdir('data/top100-r2-inspection',{recursive:true});await writeFile('data/top100-r2-inspection/six-to-six.json',JSON.stringify(report));
console.log(JSON.stringify({...report,daily:report.daily,perItem:undefined,latestTop100Missing:undefined}));
