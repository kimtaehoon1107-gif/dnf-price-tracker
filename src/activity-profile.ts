import {seasonalProfile,type SeasonalItem} from './seasonal-profile.ts';
import {HOUR} from './intraday-study.ts';
// 지표마다 다른 날짜/시간을 비교하지 않도록, 먼저 같은 아이템의 동시 관측을 맞춘다.
// 체결 봉이 없는 시간은 실제 무거래와 미관측을 구분할 수 없어 0으로 채우지 않는다.
export function activityProfiles(items:SeasonalItem[],asOf:string) {
  const cutoff=Math.floor(Date.parse(asOf)/HOUR)*HOUR;
  return ['소울 결정','유랑악단 패키지','레전더리 P10'].map(name=>{
    const legendary=name==='레전더리 P10';
    const members=items.filter(i=>legendary?i.id==='legendary:p10':i.category===name);
    const metrics=legendary?['price','listings'] as const:['price','traded','stock'] as const;
    const aligned=members.map(i=>{
      const maps=metrics.map(m=>new Map((i[m]??[]).filter(p=>p.t<cutoff&&p.price!=null&&Number.isFinite(p.price)&&p.price>=0&&(m!=='price'||p.price>0)).map(p=>[p.t,p])));
      const times=[...maps[0].keys()].filter(t=>maps.every(m=>m.has(t)));
      return {item:i,points:maps.map(m=>times.map(t=>m.get(t)!))};
    });
    const metricItems=metrics.map((_,j)=>aligned.map(a=>({...a.item,price:a.points[j]})));
    const initial=metricItems.map(xs=>seasonalProfile(xs,'price',cutoff));
    const common=new Set(initial[0].dates.filter(d=>initial.every(p=>p.dates.includes(d))));
    return {name,id:legendary?'legendary:p10':'group:'+name,
      metrics:metrics.map((metric,j)=>({metric,profile:seasonalProfile(metricItems[j],'price',cutoff,common)}))};
  });
}
