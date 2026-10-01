import {HOUR,DAY,mean,type Point} from './intraday-study.ts';
export type SeasonalItem={id:string;name:string;category:string;price:Point[];listings:Point[]};
const date=(t:number)=>new Date(t).toISOString().slice(0,10);
const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length?(s.length%2?s[m]:(s[m-1]+s[m])/2):null};
const monday=(d:string)=>{const t=Date.parse(d+'T00:00:00Z');return date(t-((new Date(t).getUTCDay()+6)%7)*DAY)};
function days(points:Point[],boundary:number,cutoff:number) {
  const bins=new Map<string,(number|null)[]>();
  for(const p of points){if(p.t>=cutoff)continue;const d=date(p.t+(9-boundary)*HOUR),start=Date.parse(d+'T00:00:00Z')+(boundary-9)*HOUR;
    if(start<cutoff-56*DAY||start+DAY>cutoff)continue;
    if(!bins.has(d))bins.set(d,Array(24).fill(null));
    if(p.price!=null&&Number.isFinite(p.price)&&p.price>=0)bins.get(d)![(p.t-start)/HOUR]=p.price;
  }
  return new Map([...bins].filter(([,ps])=>ps.filter(p=>p!=null).length>=18&&mean(ps.filter(p=>p!=null) as number[])!>0));
}
export function seasonalProfile(items:SeasonalItem[],metric:'price'|'listings',cutoff:number) {
  const samples=items.map(i=>[days(i[metric],0,cutoff),days(i[metric],6,cutoff)]);
  const common=items.length?[...samples[0][0].keys()].filter(d=>samples.every(s=>s.every(b=>b.has(d)))).sort():[];
  const weeks=[...new Set(common.map(monday))].filter(w=>common.filter(d=>monday(d)===w).length===7);
  return {members:items.map(i=>({id:i.id,name:i.name})),days:common.length,from:common[0]??null,to:common.at(-1)??null,weeks:weeks.length,
    boundaries:[0,6].map((boundary,b)=>{
      const normalized=samples.map(s=>new Map(common.map(d=>{
        const ps=s[b].get(d)!,avg=mean(ps.filter(p=>p!=null) as number[])!;
        return [d,ps.map(p=>p==null?null:p/avg*100)];
      })));
      const hourly=Array.from({length:24},(_,h)=>{
        const values=common.flatMap(d=>{const v=normalized.map(s=>s.get(d)![h]);return v.every(p=>p!=null)?[mean(v as number[])!]:[]});
        return {hour:(h+boundary)%24,n:values.length,index:mean(values),median:median(values)};
      });
      const weekday=Array.from({length:7},(_,dow)=>{
        const values=weeks.map(w=>{
          const ds=common.filter(d=>monday(d)===w).sort();
          return mean(samples.map(s=>{
            const avgs=ds.map(d=>mean(s[b].get(d)!.filter(p=>p!=null) as number[])!);
            return avgs[dow]/mean(avgs)!*100;
          }))!;
        });return {dow,n:values.length,index:mean(values),values};
      });
      // 하루 시작/끝 비교도 모든 구성품과 두 구간이 관측된 날만 사용한다.
      const changes=common.flatMap(d=>{
        const blocks=[0,21].map(start=>{
          const hs=Array.from({length:3},(_,k)=>normalized.map(s=>s.get(d)![start+k])).filter(v=>v.every(p=>p!=null));
          return hs.length>=2?mean(hs.map(v=>mean(v as number[])!)):null;
        });return blocks[0]!=null&&blocks[0]>0&&blocks[1]!=null?[(blocks[1]/blocks[0]-1)*100]:[];
      });
      return {boundary,hourly,weekday,changes:{n:changes.length,up:changes.filter(v=>v>0).length,down:changes.filter(v=>v<0).length,meanPct:mean(changes)}};
    })};
}
export function seasonalExport(items:SeasonalItem[],asOf:string) {
  const cutoff=Math.floor(Date.parse(asOf)/HOUR)*HOUR;
  const categories=[...new Set(items.filter(i=>i.category!=='레전더리 지표').map(i=>i.category))];
  const sets=[...categories.map(category=>({id:'group:'+category,name:category,items:items.filter(i=>i.category===category)})),
    ...items.map(i=>({id:i.id,name:i.name,items:[i]}))];
  return {asOf,windowDays:56,minimumHours:18,sets:sets.map(s=>({id:s.id,name:s.name,price:seasonalProfile(s.items,'price',cutoff),listings:seasonalProfile(s.items,'listings',cutoff)}))};
}
