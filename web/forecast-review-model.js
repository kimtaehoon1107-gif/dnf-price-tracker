export const forecastModels=['last','arima110','weekday_arima'];
export function comparisonSummary(rows){
  return Object.fromEntries(forecastModels.map(model=>[model,{
    mape:rows.length?rows.reduce((sum,r)=>sum+Math.abs(r.pred[model]/r.actual-1)*100,0)/rows.length:null,
    failures:rows.filter(r=>r.failed.includes(model)).length,
  }]));
}
