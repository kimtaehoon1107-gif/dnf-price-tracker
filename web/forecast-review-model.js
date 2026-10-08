export const forecastModels=['last','arima110','weekday_arima'];
export const forecastItemNames={
  c7d845c65ab9dbcff6e55dc910fbea87:'에픽 소울 결정',
  c6947ff630cc59aebdcbabfb449258d1:'레전더리 소울 결정',
  f9941d3fa0b8253bb0b2567a29b1299f:'닳아버린 순례의 증표',
};
// 평균 오차를 나란히 놓고 비교해도 되는 최소 평가 수. 요일 모델은 일곱 요일을 한 번씩은 봐야
// 판단할 수 있으므로 한 주(7건)로 둔다. 실측: 7일 뒤는 품목마다 1건뿐이라 0.77% 같은 값이 크게 보였다.
export const MIN_COMPARABLE=7;
const error=(r,model)=>Math.abs(r.pred[model]/r.actual-1)*100;
export function comparisonSummary(rows){
  return Object.fromEntries(forecastModels.map(model=>[model,{
    mape:rows.length?rows.reduce((sum,r)=>sum+error(r,model),0)/rows.length:null,
    failures:rows.filter(r=>r.failed.includes(model)).length,
    // 마지막 가격 유지보다 오차가 작았던 날. 기준선 자신은 비교 대상이 아니다.
    wins:model==='last'?null:rows.filter(r=>error(r,model)<error(r,'last')).length,
  }]));
}
// 선택한 한 조합만 보면 가장 유리한 칸을 고른 것처럼 보이므로 품목×거리 전체를 같은 형식으로 낸다.
export function overview(items,horizons=[1,3,7]){
  return items.flatMap(item=>horizons.map(h=>{
    const rows=item.rows.filter(r=>r.h===h);
    return {name:item.name,h,n:rows.length,scores:comparisonSummary(rows)};
  }));
}
// 1·2·2.5·5 배수의 눈금. 1,161,272 같은 값이 축에 나오지 않게 한다.
export function niceTicks(min,max,count=5){
  if(!Number.isFinite(min)||!Number.isFinite(max))return {ticks:[],lo:0,hi:1};
  if(max<=min){const pad=Math.max(Math.abs(min)*.05,1);min-=pad;max+=pad;}
  const raw=(max-min)/(count-1),pow=10**Math.floor(Math.log10(raw));
  const step=[1,2,2.5,5,10].map(m=>m*pow).find(s=>s>=raw);
  const lo=Math.floor(min/step+1e-9)*step,hi=Math.ceil(max/step-1e-9)*step;
  const ticks=[];
  for(let i=0;lo+i*step<=hi+step/1e6;i++)ticks.push(Number((lo+i*step).toPrecision(12)));
  return {ticks,lo:ticks[0],hi:ticks.at(-1)};
}
