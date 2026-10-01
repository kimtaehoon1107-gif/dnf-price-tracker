// R2 읽기 전용. 운영 DB/API/사이트/R2 객체를 변경하지 않는다.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {r2Store,projectArchiveStore,readManifest,readRows,hash} from '../src/archive.ts';
import {compareBoundaries,HOUR,type Point} from '../src/intraday-study.ts';
const config=JSON.parse(readFileSync('config/history-sources.json','utf8'));
const root=r2Store(), sources:any[]=[], input:any[]=[];
const tables=['items','candles_1h','listing_snapshots','legendary_card_floor'];
for(const source of [{schema:'hist_a',project:null,manifest:config.frozen.manifest},...config.live]) {
  const store=source.project?projectArchiveStore(root,source.project):root;
  const saved=await readManifest(store,source.manifest);assert(saved);
  assert(await store.get(`verified/${saved.id.slice(10,-5)}.json`),'검증된 보관본만 사용');
  sources.push({schema:source.schema,id:saved.id,asOf:saved.manifest.createdAt});
  const shards=saved.manifest.shards.filter(s=>tables.includes(s.table));
  let next=0;
  await Promise.all(Array.from({length:8},async()=>{
    while(next<shards.length){const s=shards[next++];
      for(const r of await readRows(store,s))input.push({source:source.schema,table:s.table,row:JSON.parse(r.row)});
    }
  }));
  console.log(source.schema,saved.manifest.createdAt,shards.length,'verified shards');
}
const cutoff=Math.floor(Math.min(...sources.filter(s=>s.schema!=='hist_a').map(s=>Date.parse(s.asOf)))/HOUR)*HOUR;
const owns=(source:string,t:number,itemId?:string,end=t)=>
  (itemId?config.owners.filter((o:any)=>o.itemId===itemId):config.globals).some((o:any)=>
    o.source===source&&(o.from==null||t>=Date.parse(o.from))&&(o.to==null||end<Date.parse(o.to)));
const items=new Map<string,any>();
for(const r of input.filter(r=>r.table==='items'))if(config.owners.some((o:any)=>o.itemId===r.row.item_id&&o.source===r.source&&o.to==null))items.set(r.row.item_id,r.row);
const series=new Map<string,{id:string;name:string;basis:string;points:Map<number,any>}>();
function put(id:string,name:string,basis:string,t:number,price:any,observed:number) {
  const hour=Math.floor(t/HOUR)*HOUR;if(hour>=cutoff)return;
  const key=id+'/'+basis;
  if(!series.has(key))series.set(key,{id,name,basis,points:new Map()});
  const points=series.get(key)!.points,prior=points.get(hour);
  // 마지막 상태가 매물 없음이면 null을 남기고 앞선 가격으로 채우지 않는다.
  if(!prior||observed>prior.observed)points.set(hour,{t:hour,price:price!=null&&Number(price)>0?Number(price):null,observed});
}
let boundaryCandles=0;
for(const {source,table,row:r} of input) {
  const item=items.get(r.item_id);
  if(table==='candles_1h'&&item&&item.category!=='카드') {
    const t=Date.parse(r.hour);
    if(!owns(source,t,r.item_id,t+HOUR-1)){if(owns(source,t,r.item_id))boundaryCandles++;continue;}
    put(r.item_id,item.item_name,'체결 시간봉 VWAP',t,r.vwap,t);
  }
  if(table==='listing_snapshots'&&item&&item.category==='카드') {
    const t=Date.parse(r.captured_at);if(!owns(source,t,r.item_id))continue;
    if(r.upgrade===0||r.upgrade==null)put(r.item_id,item.item_name,'미업글 최저호가',t,r.min_unit_price,t);
    if(r.upgrade>0&&r.upgrade===r.upgrade_max)put(r.item_id,item.item_name,'풀업 최저호가',t,r.min_unit_price,t);
  }
  if(table==='legendary_card_floor') {
    const t=Date.parse(r.captured_at);if(!owns(source,t))continue;
    put('legendary','레전더리 카드 저가 지표','최저가',t,r.min_unit_price,t);
    put('legendary','레전더리 카드 저가 지표','P10',t,r.p10,t);
  }
}
const results=[...series.values()].map(s=>{
  const points=[...s.points.values()].sort((a,b)=>a.t-b.t);
  return {id:s.id,name:s.name,basis:s.basis,observations:points.length,first:new Date(points[0].t).toISOString(),last:new Date(points.at(-1).t).toISOString(),...compareBoundaries(points,cutoff)};
});
const report={asOf:new Date(cutoff).toISOString(),sources,inputHash:hash(JSON.stringify(sources)),
  rules:{timezone:'Asia/Seoul',boundaries:[0,6],minimumHours:18,endpoint:'첫/끝 3시간 각각 2개 이상인 경우 평균 비교',weekday:'두 경계 공통 유효일로 구성된 완전한 월~일 주만 사용. 주 평균=100',noInterpolation:true,exploratory:true,boundaryCandlesExcluded:boundaryCandles},
  items:items.size,results};
mkdirSync('data/intraday-study',{recursive:true});
writeFileSync('data/intraday-study/report.json',JSON.stringify(report));
// 결과와 함께 재계산 가능한 시간별 연구 입력을 보존한다.
writeFileSync('data/intraday-study/hourly.json',JSON.stringify([...series.values()].map(s=>({...s,points:[...s.points.values()]}))));
const rows=[['아이템','가격기준','일자기준','날짜','완료','유효시간','분석가능','처음끝변화%','기울기24h%','R2',...Array.from({length:24},(_,i)=>'경과'+i+'시')]];
for(const r of results)for(let i=0;i<2;i++)for(const d of r.paths[i])rows.push([r.name,r.basis,String(i*6),d.d,String(d.complete),String(d.hours),String(d.eligible),String(d.changePct??''),String(d.slope24hPct??''),String(d.r2??''),...d.prices.map(p=>String(p??''))]);
writeFileSync('data/intraday-study/daily.csv','\ufeff'+rows.map(r=>r.map(x=>'"'+x.replaceAll('"','""')+'"').join(',')).join('\n'));
console.log(JSON.stringify({asOf:report.asOf,items:items.size,series:results.length,eligible:results.filter(r=>r.commonDays>0).length,fourWeeks:results.filter(r=>r.fullWeeks.length>=4).length,boundaryCandles},null,2));
