import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepare} from '../src/activity-study.ts';
import {studySeries,score,paired} from '../src/intraday-joint-forecast.ts';
const text=readFileSync('data/intraday-study/activity-input.json','utf8'),input=JSON.parse(text);
const results=prepare(input).map(series=>{
  const study=studySeries(series,Date.parse(input.asOf));
  const comparisons=[['clock','trend'],['stock','clock'],['trend','hold'],['clock','hold'],['stock','hold']] as const;
  return {...study,overall:score(study.rows),noThursday:score(study.rows.filter(r=>new Date(r.day).getUTCDay()!==4)),known:score(study.rows.filter(r=>r.known)),paired:comparisons.map(([a,b])=>paired(study.rows,a,b))};
});
const report={asOf:input.asOf,inputHash:createHash('sha256').update(text).digest('hex'),sources:input.sources,protocol:'docs/intraday-joint-protocol-2026-10-01.md',results};
writeFileSync('data/intraday-study/joint-forecast-results.json',JSON.stringify(report,null,2));
writeFileSync('data/intraday-study/joint-forecast-summary.json',JSON.stringify(report,(k,v)=>k==='rows'?undefined:v,2));
for(const r of results)console.log(JSON.stringify({name:r.name,coverage:r.coverage,models:r.overall.models.map(m=>({model:m.model,n:m.n,mape:m.mape,direction:m.direction[1].accuracy,balanced:m.direction[1].balancedAccuracy})),alwaysDown:r.overall.constantDirections[1].down.accuracy,paired:r.paired},null,2));
