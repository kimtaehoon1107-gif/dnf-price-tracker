// 탐색 분석: 유의성이나 매매 유용성을 판정하지 않는다.
export const HOUR = 3600000, DAY = 24 * HOUR;
export type Point = { t: number; price: number | null; qty?: number };
export const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const date = (t: number) => new Date(t).toISOString().slice(0,10);
export function dailyPaths(points: Point[], boundary: number, cutoff: number) {
  const bins = new Map<string, Point[]>();
  for (const p of points) {
    const d = date(p.t + (9-boundary)*HOUR);
    if (!bins.has(d)) bins.set(d, []);
    bins.get(d)!.push(p);
  }
  return [...bins].sort(([a],[b])=>a.localeCompare(b)).map(([d, ps])=> {
    const start = Date.parse(d+'T00:00:00Z')+(boundary-9)*HOUR;
    const prices = Array.from({length:24},(_,h)=>ps.find(p=>p.t===start+h*HOUR)?.price??null);
    const valid = prices.flatMap((p,h)=>p!=null&&p>0?[{h,p}]:[]);
    const complete = start>=Math.min(...points.map(p=>p.t)) && start+DAY<=cutoff;
    const first = valid.filter(p=>p.h<3), last = valid.filter(p=>p.h>=21);
    const eligible = complete && valid.length>=18;
    const avg = mean(valid.map(p=>p.p));
    const x = mean(valid.map(p=>p.h))??0, y=mean(valid.map(p=>Math.log(p.p)))??0;
    const xx=valid.reduce((s,p)=>s+(p.h-x)**2,0);
    const xy=valid.reduce((s,p)=>s+(p.h-x)*(Math.log(p.p)-y),0);
    const yy=valid.reduce((s,p)=>s+(Math.log(p.p)-y)**2,0);
    const slope=xx?xy/xx:0;
    return {d,complete,hours:valid.length,eligible,prices,average:avg,
      changePct:eligible&&first.length>=2&&last.length>=2
        ?(mean(last.map(p=>p.p))!/mean(first.map(p=>p.p))!-1)*100:null,
      slope24hPct:eligible?(Math.exp(slope*24)-1)*100:null,
      r2:eligible&&xx&&yy?xy*xy/(xx*yy):null,
      lowHour:valid.length?valid.reduce((a,b)=>a.p<=b.p?a:b).h:null,
      highHour:valid.length?valid.reduce((a,b)=>a.p>=b.p?a:b).h:null};
  });
}
export function compareBoundaries(points: Point[], cutoff: number) {
  const paths=[dailyPaths(points,0,cutoff),dailyPaths(points,6,cutoff)];
  const common=paths[0].filter(a=>a.eligible&&paths[1].some(b=>b.d===a.d&&b.eligible)).map(a=>a.d);
  const paired=paths.map(ps=>ps.filter(p=>common.includes(p.d)));
  const week=(d:string)=>{const t=Date.parse(d+'T00:00:00Z');return date(t-((new Date(t).getUTCDay()+6)%7)*DAY)};
  const fullWeeks=[...new Set(common.map(week))].filter(w=>common.filter(d=>week(d)===w).length===7);
  return {commonDays:common.length,fullWeeks,paths,summary:paired.map((ps,i)=>{
    const changes=ps.flatMap(p=>p.changePct==null?[]:[p.changePct]);
    return {boundary:[0,6][i],pairedChanges:changes.length,up:changes.filter(v=>v>0).length,
      down:changes.filter(v=>v<0).length,flat:changes.filter(v=>v===0).length,
      meanChangePct:mean(changes),
      hourly:Array.from({length:24},(_,h)=>{const a=ps.flatMap(p=>p.prices[h]!=null?[p.prices[h]!/p.average!*100]:[]);return {hour:(h+[0,6][i])%24,n:a.length,index:mean(a)}}),
      weekday:Array.from({length:7},(_,dow)=>{
        const ds=ps.filter(p=>fullWeeks.includes(week(p.d))&&(new Date(p.d+'T00:00:00Z').getUTCDay()+6)%7===dow);
        const indices=ds.map(p=>p.average!/mean(ps.filter(q=>week(q.d)===week(p.d)).map(q=>q.average!))!*100);
        return {dow,n:ds.length,index:mean(indices),weeks:ds.map((p,j)=>({d:p.d,index:indices[j],changePct:p.changePct}))};
      })};})};
}
