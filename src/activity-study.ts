// 탐색 연구. 미관측 시간을 보간하지 않고 학습 정답은 예측 원점 이후를 사용하지 않는다.
export const H=3600000,D=24*H;
export const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export const med=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null};
export type Observation={t:number;price:number;stock:number;traded?:number;known:boolean;clean:boolean;overlap?:boolean};
export type Series={id:string;name:string;category:string;points:Observation[]};
const date=(t:number)=>new Date(t).toISOString().slice(0,10);
export function prepare(input:any):Series[]{
  const cutoff=Date.parse(input.asOf),quality=new Map<string,any[]>(),scans=new Map<number,any>();
  for(const {table,row:r} of input.rows){
    if(table==='collection_quality'){const key=r.item_id+'/'+Math.floor(Date.parse(r.started_at)/H);if(!quality.has(key))quality.set(key,[]);quality.get(key)!.push(r);}
    if(table==='legendary_card_scans'&&r.status==='complete'&&r.finished_at)scans.set(Date.parse(r.finished_at),r);
  }
  const out:Series[]=[];
  for(const item of [...input.items,{item_id:'legendary:p10',item_name:'레전더리 P10',category:'레전더리 P10'}]){
    const candles=new Map<number,any>(),snapshots=new Map<number,any>();
    for(const {table,row:r} of input.rows){
      const legendary=item.item_id==='legendary:p10';
      if(!legendary&&r.item_id!==item.item_id)continue;
      if(!legendary&&table==='candles_1h')candles.set(Date.parse(r.hour),r);
      if((!legendary&&table==='listing_snapshots'&&(r.upgrade==null||r.upgrade===0))||(legendary&&table==='legendary_card_floor'&&r.upgrade===0)){
        const stamp=Date.parse(r.captured_at),t=Math.floor(stamp/H)*H,old=snapshots.get(t);
        if(!old||stamp>old.stamp||(stamp===old.stamp&&Number(r.id)>Number(old.id)))snapshots.set(t,{...r,stamp});
      }
    }
    const points:Observation[]=[];
    for(const [t,s] of snapshots){
      if(t>=cutoff)continue;
      const legendary=item.item_id==='legendary:p10',c=candles.get(t),q=quality.get(item.item_id+'/'+t/H)??[],scan=scans.get(s.stamp);
      const rawStock=legendary?s.total_listings:s.total_qty;
      if(rawStock==null)continue;
      const price=Number(legendary?s.p10:c?.vwap),stock=Number(rawStock),traded=legendary?undefined:Number(c?.qty);
      if(!(price>0)||!Number.isFinite(stock)||stock<0||(!legendary&&!(traded!>0)))continue;
      const known=legendary?!!scan:q.some(r=>r.status==='success'&&r.finished_at&&Date.parse(r.finished_at)<cutoff)&&q.every(r=>r.status==='success');
      const clean=known&&(legendary?scan.observations.every((o:any)=>!o.capped):q.every(r=>!r.saturated&&r.sold_rows<100&&r.listing_rows<400));
      const overlap=known&&(legendary?scan.observations.every((o:any)=>!o.capped):q.every(r=>!r.saturated&&r.listing_rows<400));
      points.push({t,price,stock,traded,known,clean,overlap});
    }
    out.push({id:item.item_id,name:item.item_name,category:item.category,points:points.sort((a,b)=>a.t-b.t)});
  }
  return out;
}
export type Mode='all'|'noThursday'|'known'|'overlap'|'clean';
const accept=(p:Observation,mode:Mode)=>mode==='known'?p.known:mode==='clean'?p.clean:mode==='overlap'?!!p.overlap:mode==='noThursday'?new Date(p.t+9*H).getUTCDay()!==4:true;
export function summarize(daily:{day:string;pct:number}[]){const values=daily.map(d=>d.pct);return {n:values.length,up:values.filter(v=>v>0).length,down:values.filter(v=>v<0).length,medianPct:med(values),meanPct:avg(values),daily};}
export function repetition(series:Series[],metric:'price'|'stock'|'traded',cutoff:number,boundary=6,mode:Mode='all'){
  const maps=series.map(s=>new Map(s.points.filter(p=>accept(p,mode)).map(p=>[p.t,p]))),daily:any[]=[];
  if(!maps.length)return {n:0,up:0,down:0,medianPct:null,meanPct:null,daily};
  const dates=[...new Set([...maps[0].keys()].map(t=>date(t+(9-boundary)*H)))].sort();
  for(const day of dates){
    const start=Date.parse(day)+(boundary-9)*H;
    if(start+D>cutoff||maps.some(m=>Array.from({length:24},(_,h)=>m.get(start+h*H)?.[metric]).filter(v=>v!=null).length<18))continue;
    const blocks=[6,18].map(hour=>Array.from({length:3},(_,h)=>start+((hour+h-boundary+24)%24)*H).filter(t=>maps.every(m=>m.get(t)?.[metric]!=null)));
    if(blocks.some(b=>b.length<2))continue;
    const changes=maps.map(m=>{const a=avg(blocks[0].map(t=>m.get(t)![metric]!))!,b=avg(blocks[1].map(t=>m.get(t)![metric]!))!;return a>0?(b/a-1)*100:null});
    if(changes.some(x=>x==null))continue;
    daily.push({day,pct:avg(changes as number[]),components:changes});
  }
  return summarize(daily);
}
type Sample={t:number;end:number;x:number[];y:number};
export function forecastSamples(points:Observation[],horizon:number):Sample[]{
  const map=new Map(points.map(p=>[p.t,p]));
  return points.flatMap(p=>{
    const prev=map.get(p.t-H),next=map.get(p.t+horizon*H);
    if(!prev||!next)return [];
    return [{t:p.t,end:next.t,x:[Math.log(p.price/prev.price),Math.log((1+p.stock)/(1+prev.stock))],y:Math.log(next.price/p.price)}];
  });
}
// Ridge 벌점은 1로 고정한다. 표준화도 학습 구간에서만 계산한다.
export function predict(train:Sample[],x:number[],dimensions:number){
  const means=Array.from({length:dimensions},(_,j)=>avg(train.map(r=>r.x[j]))!),sd=means.map((m,j)=>Math.sqrt(avg(train.map(r=>(r.x[j]-m)**2))!)||1);
  const rows=train.map(r=>[1,...means.map((m,j)=>(r.x[j]-m)/sd[j])]),n=dimensions+1;
  const a=Array.from({length:n},(_,i)=>Array.from({length:n+1},(_,j)=>j===n?rows.reduce((s,r,k)=>s+r[i]*train[k].y,0):rows.reduce((s,r)=>s+r[i]*r[j],0)+(i===j&&i>0?1:0)));
  for(let i=0;i<n;i++){const pivot=a[i][i];for(let j=i;j<=n;j++)a[i][j]/=pivot;for(let k=0;k<n;k++)if(k!==i){const v=a[k][i];for(let j=i;j<=n;j++)a[k][j]-=v*a[i][j];}}
  return [1,...means.map((m,j)=>(x[j]-m)/sd[j])].reduce((s,v,j)=>s+v*a[j][n],0);
}
export function forecast(points:Observation[],horizon:number){
  const samples=forecastSamples(points,horizon),predictions:any[]=[];
  for(const s of samples){
    // At the end of origin hour, that hour's price and stock are known. Label endpoints <= origin only.
    const train=samples.filter(r=>r.t<s.t&&r.end<=s.t);
    if(train.length<100||s.t-samples[0].t<7*D)continue;
    const preds=[0,predict(train,s.x,1),predict(train,s.x,2)];
    predictions.push({t:s.t,day:date(s.t+9*H),actual:s.y,predictions:preds,errors:preds.map(p=>Math.abs(Math.expm1(p-s.y))*100)});
  }
  const days=[...new Set(predictions.map(p=>p.day))],daily=days.map(day=>{const rows=predictions.filter(p=>p.day===day);return {day,n:rows.length,errors:[0,1,2].map(i=>avg(rows.map(r=>r.errors[i]))!)}});
  return {horizon,n:predictions.length,days:days.length,mape:[0,1,2].map(i=>avg(predictions.map(r=>r.errors[i]))),dailyWinsVsPrice:daily.filter(d=>d.errors[2]<d.errors[1]).length,daily,predictions};
}
