// 기술적 역사 비교: 참고 범위는 효과의 신뢰구간이나 p값이 아니다.
export const HOUR = 3_600_000;
export type Candle = {hour:string;vwap:number;qty:number;n:number};
export function quantile(xs:number[], p:number) {
  const sorted=[...xs].sort((a,b)=>a-b), index=(sorted.length-1)*p;
  if (!sorted.length) return null;
  return sorted[Math.floor(index)]+(sorted[Math.ceil(index)]-sorted[Math.floor(index)])*(index%1);
}
export function windowStats(rows:Map<number,Candle>, start:number, hours:number) {
  const points=Array.from({length:hours},(_,i)=>rows.get(start+i*HOUR));
  if (points.some(x=>!x||!(x.vwap>0&&x.qty>0&&x.n>0))) return null;
  const valid=points as Candle[], qty=valid.reduce((s,x)=>s+x.qty,0);
  return {price:valid.reduce((s,x)=>s+x.vwap*x.qty,0)/qty,qty,trades:valid.reduce((s,x)=>s+x.n,0),hours};
}
export function change(rows:Map<number,Candle>, at:number, beforeHours:number, afterHours:number) {
  const before=windowStats(rows,at-beforeHours*HOUR,beforeHours),after=windowStats(rows,at,afterHours);
  if (!before||!after) return null;
  return {before,after,pricePct:100*(after.price/before.price-1),qtyPct:100*((after.qty/afterHours)/(before.qty/beforeHours)-1)};
}
function touchesThursday(start:number,end:number) {
  for(let t=start;t<end;t+=HOUR) if(new Date(t+9*HOUR).getUTCDay()===4) return true;
  return false;
}
export function study(candles:Candle[], at:number, announced:number, beforeHours:number, afterHours:number,
  mode:'all'|'noThursday'|'Tuesday'='all') {
  const rows=new Map(candles.map(x=>[Date.parse(x.hour),x]));
  if(rows.size!==candles.length) throw new Error('중복 시간봉');
  const actual=change(rows,at,beforeHours,afterHours), references=[];
  for(let day=28;day>=1;day--) {
    const anchor=at-day*24*HOUR;
    if(anchor+afterHours*HOUR>announced) continue;
    if(mode==='noThursday'&&touchesThursday(anchor-beforeHours*HOUR,anchor+afterHours*HOUR)) continue;
    if(mode==='Tuesday'&&new Date(anchor+9*HOUR).getUTCDay()!==2) continue;
    const result=change(rows,anchor,beforeHours,afterHours);
    if(result) references.push({at:new Date(anchor).toISOString(),...result});
  }
  const enough=references.length>=(mode==='Tuesday'?4:20), median=quantile(references.map(x=>x.pricePct),.5);
  const low=quantile(references.map(x=>x.pricePct),.05),high=quantile(references.map(x=>x.pricePct),.95);
  return {beforeHours,afterHours,mode,actual,references,referenceCount:references.length,median,low,high,
    excessPp:actual&&median!==null?actual.pricePct-median:null,
    status:!actual||!enough?'자료 부족':actual.pricePct<low!||actual.pricePct>high!?'평소 범위 밖(탐색)':'뚜렷한 이례성 증거 부족'};
}
