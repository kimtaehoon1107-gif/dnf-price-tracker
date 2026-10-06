export const forecastModels=['last','arima110','weekday_arima'];
export const forecastItemNames={
  c7d845c65ab9dbcff6e55dc910fbea87:'에픽 소울 결정',
  c6947ff630cc59aebdcbabfb449258d1:'레전더리 소울 결정',
  f9941d3fa0b8253bb0b2567a29b1299f:'닳아버린 순례의 증표',
};
export function comparisonSummary(rows){
  return Object.fromEntries(forecastModels.map(model=>[model,{
    mape:rows.length?rows.reduce((sum,r)=>sum+Math.abs(r.pred[model]/r.actual-1)*100,0)/rows.length:null,
    failures:rows.filter(r=>r.failed.includes(model)).length,
  }]));
}
